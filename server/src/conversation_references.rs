use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use opentopia_core::model::MessagePart;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const REFERENCE_PREFIX: &str = "videoflow-ref:";
const LEGACY_REFERENCE_HEADER: &str = "\n\n引用资产：\n";
const LEGACY_ATTACHMENT_HEADER: &str = "\n\n附件：";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReference {
    pub id: String,
    pub name: String,
    pub kind: String,
}

pub fn reference_part(reference: &WorkspaceReference) -> Result<MessagePart> {
    let payload = serde_json::to_vec(reference)?;
    let encoded = URL_SAFE_NO_PAD.encode(payload);
    Ok(MessagePart::FileRef {
        path: PathBuf::from(format!("{REFERENCE_PREFIX}{encoded}")),
    })
}

pub fn decode_reference_path(path: &Path) -> Option<WorkspaceReference> {
    let encoded = path.to_str()?.strip_prefix(REFERENCE_PREFIX)?;
    let payload = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    serde_json::from_slice(&payload).ok()
}

pub fn message_model_text(parts: &[MessagePart]) -> String {
    parts
        .iter()
        .filter_map(|part| match part {
            MessagePart::Text { text } => Some(text.clone()),
            MessagePart::FileRef { path } => decode_reference_path(path)
                .map(|reference| format!("[引用资产：{}]", reference.name)),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
        .trim()
        .to_owned()
}

/// Rewrites messages produced by the former text serializer into durable
/// structured reference parts. The transformation is idempotent: once the
/// legacy suffix is removed, the row no longer matches the migration query.
pub fn migrate_legacy_message_references(database: impl AsRef<Path>) -> Result<usize> {
    let database = database.as_ref();
    if database == Path::new(":memory:") || !database.exists() {
        return Ok(0);
    }

    let mut connection = Connection::open(database).with_context(|| {
        format!(
            "failed to open {} for reference migration",
            database.display()
        )
    })?;
    let has_messages = connection
        .query_row(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'messages'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !has_messages {
        return Ok(0);
    }

    let transaction = connection.transaction()?;
    let candidates = {
        let mut statement = transaction.prepare(
            "SELECT id, parts_json FROM messages
             WHERE role = 'user' AND parts_json LIKE '%引用资产：%'",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };

    let mut migrated = 0;
    for (id, parts_json) in candidates {
        let Ok(parts) = serde_json::from_str::<Vec<MessagePart>>(&parts_json) else {
            continue;
        };
        let Some(next) = migrate_legacy_parts(&parts)? else {
            continue;
        };
        transaction.execute(
            "UPDATE messages SET parts_json = ?1 WHERE id = ?2",
            params![serde_json::to_string(&next)?, id],
        )?;
        migrated += 1;
    }
    transaction.commit()?;
    Ok(migrated)
}

fn migrate_legacy_parts(parts: &[MessagePart]) -> Result<Option<Vec<MessagePart>>> {
    if parts.len() != 1 {
        return Ok(None);
    }
    let MessagePart::Text { text } = &parts[0] else {
        return Ok(None);
    };
    let Some(header_start) = text.rfind(LEGACY_REFERENCE_HEADER) else {
        return Ok(None);
    };
    let suffix = &text[header_start + LEGACY_REFERENCE_HEADER.len()..];
    let (reference_block, attachment_suffix) = match suffix.find(LEGACY_ATTACHMENT_HEADER) {
        Some(index) => (&suffix[..index], &suffix[index..]),
        None => (suffix, ""),
    };
    let references = match reference_block
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(parse_legacy_reference)
        .collect::<Result<Vec<_>>>()
    {
        Ok(references) => references,
        // A user may have typed the same heading themselves. Only rewrite
        // rows that fully match the old serializer's format.
        Err(_) => return Ok(None),
    };
    if references.is_empty() {
        return Ok(None);
    }

    let clean_text = format!("{}{}", &text[..header_start], attachment_suffix);
    Ok(Some(interleave_references(&clean_text, &references)?))
}

fn parse_legacy_reference(line: &str) -> Result<WorkspaceReference> {
    let line = line
        .strip_prefix("- ")
        .ok_or_else(|| anyhow!("legacy reference line has no list marker"))?;
    let name_start = line
        .find('「')
        .ok_or_else(|| anyhow!("legacy reference line has no name"))?;
    let name_end = line[name_start + '「'.len_utf8()..]
        .find("」(")
        .map(|offset| name_start + '「'.len_utf8() + offset)
        .ok_or_else(|| anyhow!("legacy reference line has no id"))?;
    let id_start = name_end + "」(".len();
    let id = line[id_start..]
        .strip_suffix(')')
        .ok_or_else(|| anyhow!("legacy reference line has an invalid id"))?;
    let kind = match &line[..name_start] {
        "文本" => "text",
        "图片" => "image",
        "视频" => "video",
        value => return Err(anyhow!("unsupported legacy reference kind: {value}")),
    };
    Ok(WorkspaceReference {
        id: id.to_owned(),
        name: line[name_start + '「'.len_utf8()..name_end].to_owned(),
        kind: kind.to_owned(),
    })
}

fn interleave_references(
    text: &str,
    references: &[WorkspaceReference],
) -> Result<Vec<MessagePart>> {
    let mut result = Vec::new();
    let mut referenced = vec![false; references.len()];
    let mut offset = 0;
    while offset < text.len() {
        let next = references
            .iter()
            .enumerate()
            .filter_map(|(index, reference)| {
                let marker = format!("@{}", reference.name);
                text[offset..]
                    .find(&marker)
                    .map(|relative| (offset + relative, marker.len(), index))
            })
            .min_by_key(|(index, length, _)| (*index, std::cmp::Reverse(*length)));
        let Some((index, marker_length, reference_index)) = next else {
            break;
        };
        push_text(&mut result, &text[offset..index]);
        result.push(reference_part(&references[reference_index])?);
        referenced[reference_index] = true;
        offset = index + marker_length;
    }
    push_text(&mut result, &text[offset..]);
    for (index, reference) in references.iter().enumerate() {
        if !referenced[index] {
            result.push(reference_part(reference)?);
        }
    }
    Ok(result)
}

fn push_text(parts: &mut Vec<MessagePart>, text: &str) {
    if text.is_empty() {
        return;
    }
    match parts.last_mut() {
        Some(MessagePart::Text { text: current }) => current.push_str(text),
        _ => parts.push(MessagePart::Text {
            text: text.to_owned(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reference_codec_round_trips_unicode_metadata() {
        let reference = WorkspaceReference {
            id: "script-12".into(),
            name: "片段脚本".into(),
            kind: "text".into(),
        };
        let MessagePart::FileRef { path } = reference_part(&reference).unwrap() else {
            panic!("expected file reference");
        };
        assert_eq!(decode_reference_path(&path), Some(reference));
    }

    #[test]
    fn legacy_reference_suffix_becomes_an_inline_part() {
        let parts = vec![MessagePart::Text {
            text: "@片段脚本 改写这一段。\n\n引用资产：\n- 文本「片段脚本」(script-12)".into(),
        }];
        let migrated = migrate_legacy_parts(&parts).unwrap().unwrap();
        assert!(matches!(migrated[0], MessagePart::FileRef { .. }));
        assert_eq!(
            message_model_text(&migrated),
            "[引用资产：片段脚本] 改写这一段。"
        );
        assert!(!serde_json::to_string(&migrated)
            .unwrap()
            .contains("引用资产：\\n-"));
    }

    #[test]
    fn migration_preserves_the_attachment_section() {
        let parts = vec![MessagePart::Text {
            text: "处理。\n\n引用资产：\n- 图片「首帧」(frame-1)\n\n附件：\n- 文本「note.txt」"
                .into(),
        }];
        let migrated = migrate_legacy_parts(&parts).unwrap().unwrap();
        assert!(message_model_text(&migrated).contains("附件：\n- 文本「note.txt」"));
    }

    #[test]
    fn migration_ignores_user_authored_reference_like_text() {
        let parts = vec![MessagePart::Text {
            text: "我的备忘\n\n引用资产：\n这不是系统列表".into(),
        }];
        assert!(migrate_legacy_parts(&parts).unwrap().is_none());
    }
}
