use super::{mapping, target};
use crate::product::application::generation::resolve_generation_spec;
use crate::product::application::proposals::{
    AppliedTarget, ApplyProposalResult, CreateProposal, ProposalListQuery, ResolveProposal,
};
use crate::product::domain::{
    ChangeProposal, GenerationJob, GenerationJobId, GenerationSpec, GenerationStatus, MediaKind,
    ProductError, ProductResult, ProjectId, ProposalId, ProposalStatus, ProposalTarget,
};
use crate::product::infrastructure::sqlite::generation::storage as generation_storage;
use crate::product::infrastructure::sqlite::support::{append_event, immediate, remember, replay};
use chrono::Utc;
use rusqlite::{Connection, Transaction};
use serde_json::json;

pub(super) fn create(
    connection: &mut Connection,
    command: CreateProposal,
) -> ProductResult<ChangeProposal> {
    let tx = immediate(connection)?;
    target::ensure_storyboard(&tx, command.project_id, command.storyboard_id)?;
    if let Some(existing) = mapping::find_by_source(&tx, &command.source)? {
        if existing.project_id == command.project_id
            && existing.storyboard_id == command.storyboard_id
            && existing.target == command.target
            && existing.proposed_value == command.proposed_value
            && existing.summary == command.summary
            && existing.source.turn_id == command.source.turn_id
        {
            tx.commit()?;
            return Ok(existing);
        }
        return Err(mapping::source_reuse_error());
    }
    let snapshot = target::snapshot(
        &tx,
        command.project_id,
        command.storyboard_id,
        &command.target,
    )?
    .ok_or(ProductError::NotFound)?;
    let proposal = ChangeProposal {
        id: ProposalId::new(),
        project_id: command.project_id,
        storyboard_id: command.storyboard_id,
        target: command.target,
        base_revision: snapshot.revision,
        before_value: snapshot.value,
        proposed_value: command.proposed_value,
        summary: command.summary,
        status: ProposalStatus::Pending,
        source: command.source,
        revision: 1,
        created_at: Utc::now(),
        resolved_at: None,
    };
    mapping::insert(&tx, &proposal)?;
    append_event(
        &tx,
        proposal.project_id,
        "proposal.created",
        json!({
            "proposalId": proposal.id,
            "storyboardId": proposal.storyboard_id,
            "targetType": proposal.target.target_type(),
            "targetId": proposal.target.target_id()
        }),
    )?;
    tx.commit()?;
    Ok(proposal)
}

pub(super) fn list(
    connection: &mut Connection,
    query: ProposalListQuery,
) -> ProductResult<Vec<ChangeProposal>> {
    let tx = immediate(connection)?;
    target::ensure_storyboard(&tx, query.project_id, query.storyboard_id)?;
    let mut proposals = mapping::list_raw(&tx, query.project_id, query.storyboard_id)?;
    for proposal in &mut proposals {
        reconcile(&tx, proposal)?;
    }
    if !query.statuses.is_empty() {
        proposals.retain(|proposal| query.statuses.contains(&proposal.status));
    }
    tx.commit()?;
    Ok(proposals)
}

pub(super) fn find(
    connection: &mut Connection,
    project_id: ProjectId,
    proposal_id: ProposalId,
) -> ProductResult<Option<ChangeProposal>> {
    let tx = immediate(connection)?;
    let Some(mut proposal) = mapping::find_raw(&tx, project_id, proposal_id)? else {
        tx.commit()?;
        return Ok(None);
    };
    reconcile(&tx, &mut proposal)?;
    tx.commit()?;
    Ok(Some(proposal))
}

pub(super) fn apply(
    connection: &mut Connection,
    command: ResolveProposal,
) -> ProductResult<ApplyProposalResult> {
    let tx = immediate(connection)?;
    if let Some(result) = replay(&tx, &command.idempotency)? {
        tx.commit()?;
        return Ok(result);
    }
    let mut proposal = mapping::find_raw(&tx, command.project_id, command.proposal_id)?
        .ok_or(ProductError::NotFound)?;
    if proposal.revision != command.expected_proposal_revision {
        return Err(ProductError::RevisionConflict {
            expected: command.expected_proposal_revision,
            actual: proposal.revision,
        });
    }
    if proposal.status != ProposalStatus::Pending {
        return Err(not_pending());
    }
    let Some(snapshot) = target::snapshot(
        &tx,
        proposal.project_id,
        proposal.storyboard_id,
        &proposal.target,
    )?
    else {
        let expected = proposal.revision;
        proposal.transition(ProposalStatus::Expired, Utc::now())?;
        mapping::persist(&tx, &proposal, expected)?;
        append_proposal_event(&tx, &proposal, "proposal.expired")?;
        tx.commit()?;
        return Err(ProductError::Conflict {
            code: "PROPOSAL_EXPIRED",
            message: "proposal target no longer exists".into(),
        });
    };
    if snapshot.revision != proposal.base_revision {
        let expected = proposal.revision;
        proposal.transition(ProposalStatus::Conflicted, Utc::now())?;
        mapping::persist(&tx, &proposal, expected)?;
        append_proposal_event(&tx, &proposal, "proposal.conflicted")?;
        tx.commit()?;
        return Err(ProductError::RevisionConflict {
            expected: proposal.base_revision,
            actual: snapshot.revision,
        });
    }
    if snapshot.revision != command.expected_target_revision {
        return Err(ProductError::RevisionConflict {
            expected: command.expected_target_revision,
            actual: snapshot.revision,
        });
    }
    let generation_spec = if proposal.target.creates_generation_job() {
        let kind = generation_kind(&tx, &proposal)?;
        let spec = resolve_generation_spec(kind, command.generation_options.clone())?;
        generation_storage::validate_inputs(&tx, proposal.project_id, &spec)?;
        Some(spec)
    } else {
        if command.generation_options.is_some() {
            return Err(ProductError::Validation(
                "generation options cannot be used with a script proposal".into(),
            ));
        }
        None
    };
    let persisted_revision = proposal.revision;
    proposal.transition(ProposalStatus::Applying, Utc::now())?;
    let target_revision = target::apply(
        &tx,
        proposal.project_id,
        proposal.storyboard_id,
        &proposal.target,
        &proposal.proposed_value,
        snapshot.revision,
    )?;
    proposal.transition(ProposalStatus::Applied, Utc::now())?;
    mapping::persist(&tx, &proposal, persisted_revision)?;
    let generation_job = proposal.target.creates_generation_job().then(|| {
        generation_job(
            &proposal,
            target_revision,
            generation_spec.expect("generation target has a resolved spec"),
        )
    });
    if let Some(job) = &generation_job {
        generation_storage::insert(&tx, job)?;
        generation_storage::append_requested(&tx, job)?;
    }
    append_proposal_event(&tx, &proposal, "proposal.applied")?;
    let result = ApplyProposalResult {
        target: AppliedTarget {
            target_type: proposal.target.target_type().into(),
            revision: target_revision,
        },
        proposal,
        generation_job,
    };
    remember(&tx, &command.idempotency, &result)?;
    tx.commit()?;
    Ok(result)
}

pub(super) fn reject(
    connection: &mut Connection,
    command: ResolveProposal,
) -> ProductResult<ChangeProposal> {
    let tx = immediate(connection)?;
    if let Some(proposal) = replay(&tx, &command.idempotency)? {
        tx.commit()?;
        return Ok(proposal);
    }
    let mut proposal = mapping::find_raw(&tx, command.project_id, command.proposal_id)?
        .ok_or(ProductError::NotFound)?;
    if proposal.revision != command.expected_proposal_revision {
        return Err(ProductError::RevisionConflict {
            expected: command.expected_proposal_revision,
            actual: proposal.revision,
        });
    }
    if proposal.status == ProposalStatus::Pending {
        reconcile(&tx, &mut proposal)?;
    }
    if proposal.status == ProposalStatus::Expired {
        tx.commit()?;
        return Err(not_pending());
    }
    if !matches!(
        proposal.status,
        ProposalStatus::Pending | ProposalStatus::Conflicted
    ) {
        return Err(not_pending());
    }
    let expected = proposal.revision;
    proposal.transition(ProposalStatus::Rejected, Utc::now())?;
    mapping::persist(&tx, &proposal, expected)?;
    append_proposal_event(&tx, &proposal, "proposal.rejected")?;
    remember(&tx, &command.idempotency, &proposal)?;
    tx.commit()?;
    Ok(proposal)
}

fn reconcile(tx: &Transaction<'_>, proposal: &mut ChangeProposal) -> ProductResult<()> {
    if proposal.status != ProposalStatus::Pending {
        return Ok(());
    }
    let snapshot = target::snapshot(
        tx,
        proposal.project_id,
        proposal.storyboard_id,
        &proposal.target,
    )?;
    let next = match snapshot {
        None => Some((ProposalStatus::Expired, "proposal.expired")),
        Some(snapshot) if snapshot.revision != proposal.base_revision => {
            Some((ProposalStatus::Conflicted, "proposal.conflicted"))
        }
        Some(_) => None,
    };
    if let Some((status, event_type)) = next {
        let expected = proposal.revision;
        proposal.transition(status, Utc::now())?;
        mapping::persist(tx, proposal, expected)?;
        append_proposal_event(tx, proposal, event_type)?;
    }
    Ok(())
}

fn generation_job(
    proposal: &ChangeProposal,
    target_revision: i64,
    spec: GenerationSpec,
) -> GenerationJob {
    let now = Utc::now();
    GenerationJob {
        id: GenerationJobId::new(),
        project_id: proposal.project_id,
        storyboard_id: proposal.storyboard_id,
        proposal_id: Some(proposal.id),
        target: proposal.target.clone(),
        target_revision,
        spec,
        status: GenerationStatus::WaitingForProvider,
        attempt: 0,
        provider: None,
        provider_job_id: None,
        result_media_id: None,
        error: None,
        created_at: now,
        updated_at: now,
    }
}

fn generation_kind(tx: &Transaction<'_>, proposal: &ChangeProposal) -> ProductResult<MediaKind> {
    match proposal.target {
        ProposalTarget::MediaPrompt { media_id } => {
            target::media_kind(tx, proposal.project_id, proposal.storyboard_id, media_id)
        }
        ProposalTarget::AssetBindingPrompt { .. } => Ok(MediaKind::Image),
        ProposalTarget::Script { .. } => Err(ProductError::Validation(
            "script proposals do not create generation jobs".into(),
        )),
    }
}

fn append_proposal_event(
    tx: &Transaction<'_>,
    proposal: &ChangeProposal,
    event_type: &str,
) -> ProductResult<()> {
    append_event(
        tx,
        proposal.project_id,
        event_type,
        json!({
            "proposalId": proposal.id,
            "storyboardId": proposal.storyboard_id,
            "status": proposal.status
        }),
    )
}

fn not_pending() -> ProductError {
    ProductError::Conflict {
        code: "PROPOSAL_NOT_PENDING",
        message: "proposal is no longer pending".into(),
    }
}
