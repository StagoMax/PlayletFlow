"""Capture the local sheep workspace as a portable, read-only starter template.

Run while the local API is serving the source project. The export contains only
the named storyboard, its attached media, and the named introductory thread.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
from pathlib import Path
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "server" / ".videoflow"
WEB = ROOT / "web"
API = "http://127.0.0.1:8788"
STORYBOARD_NAME = "牧羊犬的日常-数羊"
VIDEO_NAME = "数羊-1"
THREAD_TITLE = "现在这个短剧制作Agent有哪些内置工具。"


def fetch(path: str):
    with urlopen(f"{API}{path}", timeout=10) as response:
        return json.load(response)


def one(connection: sqlite3.Connection, query: str, values: tuple[str, ...]):
    rows = connection.execute(query, values).fetchall()
    if len(rows) != 1:
        raise RuntimeError(f"Expected exactly one source row; found {len(rows)}")
    return rows[0]


def write_json(path: Path, value: object):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    product = sqlite3.connect(f"file:{SOURCE / 'product.sqlite'}?mode=ro", uri=True)
    conversation = sqlite3.connect(f"file:{SOURCE / 'conversations.sqlite'}?mode=ro", uri=True)
    storyboard_id, project_id = one(
        product,
        "SELECT id, project_id FROM storyboards WHERE name = ? AND deleted_at IS NULL",
        (STORYBOARD_NAME,),
    )
    thread_id, title, created_at, updated_at = one(
        conversation,
        "SELECT id, title, created_at, updated_at FROM threads WHERE title = ? AND archived_at IS NULL",
        (THREAD_TITLE,),
    )
    one(
        product,
        "SELECT thread_id FROM workspace_thread_bindings WHERE storyboard_id = ? AND thread_id = ?",
        (storyboard_id, thread_id),
    )
    project_id, name, revision, project_created, project_updated = one(
        product,
        "SELECT id, name, revision, created_at, updated_at FROM projects WHERE id = ?",
        (project_id,),
    )
    base = f"/api/v1/projects/{project_id}"
    storyboard = fetch(f"{base}/storyboards/{storyboard_id}")
    nodes = fetch(f"{base}/storyboards/{storyboard_id}/workspace-nodes")
    media_dir = WEB / "public" / "welcome-media"
    media_dir.mkdir(parents=True, exist_ok=True)
    object_media = {}
    video_id = None
    for node in nodes:
        if node["kind"] != "object" or node["targetType"] != "media":
            continue
        media_id = node["targetId"]
        if not media_id:
            raise RuntimeError(f"Media node {node['id']} has no target")
        media = fetch(f"{base}/media/{media_id}")
        if media["status"] != "ready":
            raise RuntimeError(f"Starter media {media_id} is not ready")
        source_key, = one(
            product,
            "SELECT source_object_key FROM media_items WHERE id = ? AND deleted_at IS NULL",
            (media_id,),
        )
        source = (SOURCE / "media" / source_key).resolve()
        if not source.is_relative_to((SOURCE / "media").resolve()) or not source.is_file():
            raise RuntimeError(f"Missing source media for {media_id}")
        destination = media_dir / f"{media_id}{source.suffix.lower()}"
        shutil.copyfile(source, destination)
        public_url = f"/welcome-media/{destination.name}"
        for access in ("preview", "thumbnail"):
            if media[access]:
                media[access]["url"] = public_url
                media[access]["expiresAt"] = None
        object_media[node["id"]] = media
        if node["name"] == VIDEO_NAME:
            video_id = node["id"]

    if not video_id:
        raise RuntimeError(f"Could not find the {VIDEO_NAME} video object")
    if not object_media[video_id]["preview"]["url"].endswith(".mp4"):
        raise RuntimeError("The welcome video has no playable MP4 preview")

    messages = fetch(f"/api/threads/{thread_id}/messages?limit=200")
    events = fetch(f"/api/threads/{thread_id}/events?limit=1000")
    if not messages or not any(message["role"] == "assistant" for message in messages):
        raise RuntimeError("Introductory conversation has no assistant response")

    write_json(WEB / "src" / "workspace" / "welcomeWorkspace.json", {
        "project": {
            "id": project_id,
            "name": name,
            "revision": revision,
            "createdAt": project_created,
            "updatedAt": project_updated,
        },
        "storyboard": storyboard,
        "nodes": nodes,
        "objectMedia": object_media,
        "initialSelection": {
            "kind": "emptyObject",
            "objectId": video_id,
            "objectType": "video",
            "nodeId": video_id,
        },
    })
    write_json(WEB / "src" / "chat" / "welcomeConversation.json", {
        "thread": {
            "id": thread_id,
            "title": title,
            "createdAt": created_at,
            "updatedAt": updated_at,
        },
        "projectId": project_id,
        "storyboardId": storyboard_id,
        "messages": messages,
        "events": events,
    })
    print(f"Captured {len(nodes)} nodes, {len(object_media)} media items, and {len(messages)} messages")


if __name__ == "__main__":
    main()
