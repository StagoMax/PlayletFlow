use std::collections::{HashMap, HashSet};

/// The prompt editor persists references in a footer and renders matching @mentions
/// from those stable IDs. Tool callers provide IDs; names always come from the
/// current storyboard snapshot rather than model-authored text.
pub(crate) struct PromptReferenceSource {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub is_script: bool,
}

pub(crate) struct ReferencedPrompt {
    pub value: String,
    pub reference_ids: Vec<String>,
}

pub(crate) fn compose_referenced_prompt(
    prompt: &str,
    explicit_ids: &[String],
    generation_media_ids: &[String],
    sources: &[PromptReferenceSource],
) -> Result<ReferencedPrompt, String> {
    let mut body = prompt.trim().to_owned();
    if body.is_empty() {
        return Err("prompt is required".into());
    }
    let mut ids = Vec::new();
    let mut seen = HashSet::<String>::new();
    for id in explicit_ids.iter().chain(generation_media_ids) {
        let id = canonical_reference_id(id, sources);
        if seen.insert(id.clone()) {
            ids.push(id);
        }
    }

    // Existing prompts may be passed back by read_storyboard_asset. Reuse their
    // references instead of adding another footer on every tool call.
    if let Some((plain, footer_ids)) = split_reference_footer(&body) {
        body = plain;
        for id in footer_ids {
            let id = canonical_reference_id(&id, sources);
            if seen.insert(id.clone()) {
                ids.push(id);
            }
        }
    }

    let name_counts = sources
        .iter()
        .fold(HashMap::<&str, usize>::new(), |mut counts, source| {
            if supported(source) {
                *counts.entry(&source.name).or_default() += 1;
            }
            counts
        });
    let mut implicit = sources
        .iter()
        .filter(|source| supported(source) && name_counts.get(source.name.as_str()) == Some(&1))
        .flat_map(|source| {
            let marker = format!("@{}", source.name);
            body.match_indices(&marker)
                .map(move |(offset, _)| (offset, source))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    implicit.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| b.1.name.len().cmp(&a.1.name.len()))
    });
    let mut previous_end = 0;
    for (offset, source) in implicit {
        if offset < previous_end {
            continue;
        }
        previous_end = offset + source.name.len() + 1;
        if seen.insert(source.id.clone()) {
            ids.push(source.id.clone());
        }
    }

    let mut footer = Vec::new();
    let mut resolved_ids = Vec::new();
    for id in ids {
        let source = sources
            .iter()
            .find(|source| source.id == id && supported(source))
            .ok_or_else(|| format!("reference {id} is not available in the current storyboard"))?;
        let editor_id = source.id.clone();
        if !has_visible_marker(&body, source, sources) {
            body.push_str(&format!(" @{}", source.name));
        }
        let kind = match source.kind.as_str() {
            "image" => "图片",
            "video" => "视频",
            _ => "文本",
        };
        if source
            .name
            .chars()
            .any(|ch| matches!(ch, '「' | '」' | '\n'))
            || editor_id.chars().any(|ch| matches!(ch, '(' | ')' | '\n'))
        {
            return Err(format!(
                "reference {id} cannot be represented in the prompt editor"
            ));
        }
        footer.push(format!("- {kind}「{}」({editor_id})", source.name));
        resolved_ids.push(editor_id);
    }
    let value = if footer.is_empty() {
        body
    } else {
        format!("{body}\n\n引用资产：\n{}", footer.join("\n"))
    };
    if value.chars().count() > 10_000 {
        return Err("prompt is too long".into());
    }
    Ok(ReferencedPrompt {
        value,
        reference_ids: resolved_ids,
    })
}

fn supported(source: &PromptReferenceSource) -> bool {
    matches!(source.kind.as_str(), "image" | "video" | "text")
}

fn canonical_reference_id(id: &str, sources: &[PromptReferenceSource]) -> String {
    if sources.iter().any(|source| source.id == id) {
        return id.to_owned();
    }
    sources
        .iter()
        .find(|source| source.is_script && source.id.strip_prefix("script-") == Some(id))
        .map_or_else(|| id.to_owned(), |source| source.id.clone())
}

fn has_visible_marker(
    body: &str,
    source: &PromptReferenceSource,
    sources: &[PromptReferenceSource],
) -> bool {
    let marker = format!("@{}", source.name);
    body.match_indices(&marker).any(|(offset, _)| {
        !sources.iter().any(|other| {
            other.name.len() > source.name.len()
                && body[offset..].starts_with(&format!("@{}", other.name))
        })
    })
}

fn split_reference_footer(prompt: &str) -> Option<(String, Vec<String>)> {
    let (body, footer) = prompt.rsplit_once("\n\n引用资产：\n")?;
    let mut ids = Vec::new();
    for line in footer.lines() {
        let (_, id) = line.rsplit_once("」(")?;
        if !line.starts_with("- 图片「")
            && !line.starts_with("- 视频「")
            && !line.starts_with("- 文本「")
        {
            return None;
        }
        let id = id.strip_suffix(')')?;
        ids.push(id.to_owned());
    }
    if ids.is_empty() {
        None
    } else {
        Some((body.to_owned(), ids))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_ids_and_reuses_existing_footer() {
        let sources = [PromptReferenceSource {
            id: "image-1".into(),
            kind: "image".into(),
            name: "牧羊犬".into(),
            is_script: false,
        }];
        let first =
            compose_referenced_prompt("参考 @牧羊犬", &["image-1".into()], &[], &sources).unwrap();
        assert_eq!(
            first.value,
            "参考 @牧羊犬\n\n引用资产：\n- 图片「牧羊犬」(image-1)"
        );
        let second = compose_referenced_prompt(&first.value, &[], &[], &sources).unwrap();
        assert_eq!(second.value, first.value);
        assert_eq!(second.reference_ids, vec!["image-1"]);
    }

    #[test]
    fn rejects_out_of_scope_references() {
        assert!(compose_referenced_prompt("画面", &["other".into()], &[], &[]).is_err());
    }

    #[test]
    fn unambiguous_mentions_link_automatically_and_overlapping_names_choose_longer_match() {
        let sources = [
            PromptReferenceSource {
                id: "short".into(),
                kind: "image".into(),
                name: "牧羊犬".into(),
                is_script: false,
            },
            PromptReferenceSource {
                id: "long".into(),
                kind: "image".into(),
                name: "牧羊犬-多视图".into(),
                is_script: false,
            },
        ];
        let prompt =
            compose_referenced_prompt("按 @牧羊犬-多视图 制作，再看 @牧羊犬", &[], &[], &sources)
                .unwrap();
        assert_eq!(prompt.reference_ids, vec!["long", "short"]);
        assert_eq!(prompt.value.matches("(short)").count(), 1);
        let ambiguous = [
            PromptReferenceSource {
                id: "a".into(),
                kind: "image".into(),
                name: "同名".into(),
                is_script: false,
            },
            PromptReferenceSource {
                id: "b".into(),
                kind: "image".into(),
                name: "同名".into(),
                is_script: false,
            },
        ];
        let prompt = compose_referenced_prompt("参考 @同名", &[], &[], &ambiguous).unwrap();
        assert!(prompt.reference_ids.is_empty());
    }

    #[test]
    fn explicit_short_reference_gets_its_own_marker_beside_a_longer_name() {
        let sources = [
            PromptReferenceSource {
                id: "short".into(),
                kind: "image".into(),
                name: "牧羊犬".into(),
                is_script: false,
            },
            PromptReferenceSource {
                id: "long".into(),
                kind: "image".into(),
                name: "牧羊犬-多视图".into(),
                is_script: false,
            },
        ];
        let prompt =
            compose_referenced_prompt("参考 @牧羊犬-多视图", &["short".into()], &[], &sources)
                .unwrap();
        assert!(prompt
            .value
            .starts_with("参考 @牧羊犬-多视图 @牧羊犬\n\n引用资产："));
        assert_eq!(prompt.reference_ids, vec!["short", "long"]);
    }
}
