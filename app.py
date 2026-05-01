from __future__ import annotations

import base64
import copy
import html
import io
import json
from datetime import datetime
import re
from pathlib import Path
from typing import Any

import fitz
import plotly.graph_objects as go
import requests
import streamlit as st
from PIL import Image

ROOT_DIR = Path(__file__).parent
DEFAULT_JSON_PATH = ROOT_DIR / "data" / "default_bundle.json"
DEFAULT_PDF_PATH = ROOT_DIR / "19381216_01.pdf"

STATUS_OPTIONS = ["pending", "done"]
STATUS_LABELS = {
    "pending": "Pending",
    "done": "Done",
}
STATUS_COLORS = {
    "pending": "#3f3f46",
    "done": "#16a34a",
}


def parse_path(path: str) -> list[Any]:
    tokens: list[Any] = []
    for token in path.split("."):
        if token.isdigit():
            tokens.append(int(token))
        else:
            tokens.append(token)
    return tokens


def get_by_path(root: Any, path: str) -> Any:
    current = root
    for token in parse_path(path):
        current = current[token]
    return current


def set_by_path(root: Any, path: str, value: Any) -> None:
    tokens = parse_path(path)
    current = root
    for token in tokens[:-1]:
        current = current[token]
    current[tokens[-1]] = value


def apply_corrections(bundle: dict[str, Any], corrections: list[dict[str, Any]]) -> None:
    for correction in corrections:
        path = correction.get("path")
        if not path:
            continue
        try:
            set_by_path(bundle, path, correction.get("corrected"))
        except Exception:
            continue


def initialize_state() -> None:
    defaults = {
        "bundle": None,
        "initial_bundle": None,
        "corrections": [],
        "current_page_index": 0,
        "selected_block_id": None,
        "search_term": "",
        "active_tab": "OCR Blocks",
        "loaded_from": "",
    }
    for key, value in defaults.items():
        if key not in st.session_state:
            st.session_state[key] = value


def load_bundle(bundle: dict[str, Any], source_label: str) -> None:
    working_bundle = copy.deepcopy(bundle)
    initial_bundle = copy.deepcopy(bundle)
    corrections = list(bundle.get("corrections", []))
    if corrections:
        apply_corrections(working_bundle, corrections)

    st.session_state.bundle = working_bundle
    st.session_state.initial_bundle = initial_bundle
    st.session_state.corrections = corrections
    st.session_state.current_page_index = 0
    st.session_state.selected_block_id = None
    st.session_state.search_term = ""
    st.session_state.loaded_from = source_label


def correction_for_path(path: str) -> dict[str, Any] | None:
    for item in st.session_state.corrections:
        if item.get("path") == path:
            return item
    return None


def add_or_update_correction(path: str, original: Any, corrected: Any, status: str, comment: str) -> None:
    correction = {
        "path": path,
        "original": original,
        "corrected": corrected,
        "status": status,
        "comment": comment.strip() if comment else "",
        "timestamp": datetime.now().isoformat(),
    }

    replaced = False
    updated: list[dict[str, Any]] = []
    for item in st.session_state.corrections:
        if item.get("path") == path:
            updated.append(correction)
            replaced = True
        else:
            updated.append(item)
    if not replaced:
        updated.append(correction)

    st.session_state.corrections = updated
    set_by_path(st.session_state.bundle, path, corrected)


@st.cache_data(show_spinner=False)
def render_pdf_pages(pdf_bytes: bytes) -> list[bytes]:
    document = fitz.open(stream=pdf_bytes, filetype="pdf")
    output: list[bytes] = []
    matrix = fitz.Matrix(2, 2)
    for page in document:
        pixmap = page.get_pixmap(matrix=matrix, alpha=False)
        output.append(pixmap.tobytes("png"))
    document.close()
    return output


def load_default_assets() -> None:
    if st.session_state.bundle is not None:
        return
    if DEFAULT_JSON_PATH.exists():
        bundle = json.loads(DEFAULT_JSON_PATH.read_text(encoding="utf-8"))
        load_bundle(bundle, "Bundled default JSON")


def get_pdf_bytes(uploaded_pdf: Any) -> bytes | None:
    if uploaded_pdf is not None:
        return uploaded_pdf.read()
    if DEFAULT_PDF_PATH.exists():
        return DEFAULT_PDF_PATH.read_bytes()
    return None


def export_bundle() -> bytes:
    final_bundle = copy.deepcopy(st.session_state.initial_bundle)
    final_bundle["corrections"] = st.session_state.corrections
    return json.dumps(final_bundle, ensure_ascii=False, indent=2).encode("utf-8")


def _github_secrets() -> tuple[str, str, str] | None:
    """Return (token, repo, branch) from Streamlit secrets, or None."""
    try:
        gh = st.secrets["github"]
        token = gh["token"]
        repo = gh["repo"]
        branch = gh.get("branch", "main")
        return token, repo, branch
    except Exception:
        return None


def _save_to_github(content_json: str) -> None:
    """Commit data/default_bundle.json to GitHub via the Contents API."""
    secrets = _github_secrets()
    if secrets is None:
        raise RuntimeError("GitHub secrets not configured")
    token, repo, branch = secrets
    api_path = "data/default_bundle.json"
    url = f"https://api.github.com/repos/{repo}/contents/{api_path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
    }

    # Get current file SHA (required for update).
    get_resp = requests.get(url, headers=headers, params={"ref": branch}, timeout=15)
    if get_resp.status_code != 200:
        raise RuntimeError(f"GitHub GET failed ({get_resp.status_code}): {get_resp.text[:200]}")
    current_sha = get_resp.json()["sha"]

    # Commit the updated file.
    encoded = base64.b64encode(content_json.encode("utf-8")).decode("ascii")
    put_resp = requests.put(
        url,
        headers=headers,
        json={
            "message": "Auto-save reviewer corrections",
            "content": encoded,
            "sha": current_sha,
            "branch": branch,
        },
        timeout=30,
    )
    if put_resp.status_code not in (200, 201):
        raise RuntimeError(f"GitHub PUT failed ({put_resp.status_code}): {put_resp.text[:200]}")


def save_bundle() -> None:
    final_bundle = copy.deepcopy(st.session_state.initial_bundle)
    final_bundle["corrections"] = st.session_state.corrections
    content_json = json.dumps(final_bundle, ensure_ascii=False, indent=2)

    if _github_secrets() is None:
        raise RuntimeError(
            "GitHub secrets are not configured. Saving is disabled — corrections will NOT be persisted. "
            "Please contact Sinai."
        )
    _save_to_github(content_json)


def block_path(page_index: int, block_index: int) -> str:
    return f"pages.{page_index}.blocks.{block_index}.transcription"


def block_status(page_index: int, block_index: int) -> str:
    path = block_path(page_index, block_index)
    correction = correction_for_path(path)
    if not correction:
        return "pending"
    status = str(correction.get("status", "pending"))
    if status in STATUS_OPTIONS:
        return status
    if status.startswith("done"):
        return "done"
    return "pending"


def get_filtered_blocks(current_page: dict[str, Any], current_page_index: int) -> list[tuple[int, dict[str, Any]]]:
    blocks = current_page.get("blocks", [])
    filtered: list[tuple[int, dict[str, Any]]] = []
    needle = st.session_state.search_term.lower().strip()
    for idx, block in enumerate(blocks):
        text = block.get("transcription", "")
        block_id = block.get("id", "")
        if needle and needle not in text.lower() and needle not in block_id.lower():
            continue
        filtered.append((idx, block))
    return filtered


def render_sidebar(
    current_page: dict[str, Any],
    current_page_index: int,
) -> tuple[int, str | None]:
    with st.sidebar:
        st.header("Review Controls")
        st.caption(st.session_state.loaded_from)

        _TAB_OPTIONS = ["OCR Blocks", "Content Units", "People", "Changes Log"]
        if st.session_state.active_tab not in _TAB_OPTIONS:
            st.session_state.active_tab = "OCR Blocks"
        st.session_state.active_tab = st.radio(
            "Navigator",
            _TAB_OPTIONS,
            index=_TAB_OPTIONS.index(st.session_state.active_tab),
            horizontal=True,
        )
        st.session_state.search_term = st.text_input("Search", value=st.session_state.search_term)

        if _github_secrets() is not None:
            st.success("Auto-save: GitHub active", icon="☁️")
        else:
            st.warning("Auto-save: local disk only (secrets not configured)", icon="⚠️")

        col_prev, col_mid, col_next = st.columns([1, 2, 1])
        with col_prev:
            if st.button("Prev", use_container_width=True, disabled=current_page_index == 0):
                current_page_index -= 1
                st.session_state.selected_block_id = None
        with col_mid:
            st.markdown(f"<div style='text-align:center;padding-top:8px;'>Page {current_page_index + 1}</div>", unsafe_allow_html=True)
        with col_next:
            if st.button(
                "Next",
                use_container_width=True,
                disabled=current_page_index >= len(st.session_state.bundle["pages"]) - 1,
            ):
                current_page_index += 1
                st.session_state.selected_block_id = None

        selected_block_id = st.session_state.selected_block_id

        if st.session_state.active_tab == "OCR Blocks":
            blocks = current_page.get("blocks", [])
            total = len(blocks)
            reviewed = sum(
                1 for i in range(total)
                if block_status(current_page_index, i) != "pending"
            )
            st.metric("Blocks reviewed", f"{reviewed} / {total}")
            st.caption("Click regions on the image or text panel to navigate.")

        elif st.session_state.active_tab == "Content Units":
            units = st.session_state.bundle.get("content_units", [])
            needle = st.session_state.search_term.lower().strip()
            shown = [u for u in units if needle in u.get("title", "").lower()]
            for unit in shown[:150]:
                st.markdown(f"**{unit.get('title', '(Untitled)')}**")
                st.caption(f"{unit.get('type', '')} | {unit.get('category', '')}")
                st.divider()

        elif st.session_state.active_tab == "People":
            people = st.session_state.bundle.get("people", [])
            needle = st.session_state.search_term.lower().strip()
            shown = [p for p in people if needle in p.get("name", "").lower()]
            for person in shown[:150]:
                st.markdown(f"**{person.get('name', '(Unknown)')}**")
                st.caption(person.get("holocaust_fate", ""))
                st.divider()

        elif st.session_state.active_tab == "Changes Log":
            corrections = st.session_state.bundle.get("corrections", [])
            total = len(corrections)
            done = sum(1 for c in corrections if c.get("status") == "done")
            col_d, col_p = st.columns(2)
            col_d.metric("Done", done)
            col_p.metric("Pending", total - done)

    return current_page_index, selected_block_id


def render_image_panel(
    current_page: dict[str, Any],
    selected_block_id: str | None,
    page_png: bytes | None,
    current_page_index: int,
) -> str | None:
    st.subheader("Page Image")
    if page_png is None:
        st.warning("No PDF image available. Upload a PDF or add 19381216_01.pdf to the project root.")
        return None

    image = Image.open(io.BytesIO(page_png)).convert("RGB")

    image_meta = current_page.get("image", {})
    source_width = float(image_meta.get("width") or image.width)
    source_height = float(image_meta.get("height") or image.height)

    figure = go.Figure()
    figure.add_layout_image(
        dict(
            source=image,
            xref="x",
            yref="y",
            x=0,
            y=0,
            sizex=source_width,
            sizey=source_height,
            sizing="stretch",
            yanchor="top",
            layer="below",
        )
    )

    selected_bbox: list[float] | None = None
    hit_x: list[float] = []
    hit_y: list[float] = []
    hit_ids: list[str] = []
    blocks = current_page.get("blocks", [])
    for idx, block in enumerate(blocks):
        bbox = block.get("bbox", [0, 0, 0, 0])
        x, y, w, h = [float(v) for v in bbox]
        block_id = block.get("id", "")
        status = block_status(current_page_index, idx)
        color = STATUS_COLORS[status]
        is_selected = block_id == selected_block_id
        if is_selected:
            selected_bbox = [x, y, w, h]

        figure.add_trace(
            go.Scatter(
                x=[x, x + w, x + w, x, x],
                y=[y, y, y + h, y + h, y],
                mode="lines",
                fill="toself",
                fillcolor="rgba(15,118,110,0.09)" if is_selected else "rgba(0,0,0,0.001)",
                line=dict(color=color if not is_selected else "#0f766e", width=3 if is_selected else 1.6),
                customdata=[[block_id]] * 5,
                hovertemplate=f"{block_id}<extra></extra>",
                showlegend=False,
            )
        )

        # Dense invisible points make the full region easy to click, not just edges.
        # Tiny regions get extra density and slight padding to remain selectable.
        cols = max(3, min(10, int(w // 120) + 2))
        rows = max(3, min(10, int(h // 80) + 2))
        pad_x = min(18.0, max(4.0, w * 0.12))
        pad_y = min(18.0, max(4.0, h * 0.12))
        left = max(0.0, x - pad_x)
        right = min(source_width, x + w + pad_x)
        top = max(0.0, y - pad_y)
        bottom = min(source_height, y + h + pad_y)
        for col_idx in range(cols):
            for row_idx in range(rows):
                hit_x.append(left + ((col_idx + 0.5) * (right - left) / cols))
                hit_y.append(top + ((row_idx + 0.5) * (bottom - top) / rows))
                hit_ids.append(block_id)

    # Invisible hit targets improve click selection reliability across dense layouts
    # and for clicks inside a block's interior.
    figure.add_trace(
        go.Scatter(
            x=hit_x,
            y=hit_y,
            mode="markers",
            marker=dict(size=22, color="rgba(0,0,0,0.001)"),
            customdata=[[bid] for bid in hit_ids],
            hovertemplate="%{customdata[0]}<extra></extra>",
            showlegend=False,
        )
    )

    x_range = [0.0, source_width]
    y_range = [source_height, 0.0]
    if selected_bbox:
        x, y, w, h = selected_bbox
        margin_x = max(80.0, w * 0.72)
        margin_y = max(80.0, h * 0.72)
        x0 = max(0.0, x - margin_x)
        x1 = min(source_width, x + w + margin_x)
        y0 = max(0.0, y - margin_y)
        y1 = min(source_height, y + h + margin_y)
        x_range = [x0, x1]
        y_range = [y1, y0]

    figure.update_layout(
        margin=dict(l=4, r=4, t=4, b=4),
        xaxis=dict(visible=False, range=x_range),
        yaxis=dict(visible=False, range=y_range, scaleanchor="x", scaleratio=1),
        dragmode=False,
        clickmode="event+select",
        height=760,
    )

    click_state = st.plotly_chart(
        figure,
        use_container_width=True,
        config={"scrollZoom": True, "displaylogo": False},
        on_select="rerun",
        selection_mode=["points", "box"],
        key=f"plot_page_{current_page_index}_{selected_block_id or 'none'}",
    )

    clicked_block_id: str | None = None
    if isinstance(click_state, dict):
        selected_points = click_state.get("selection", {}).get("points", [])
        if selected_points:
            point = selected_points[-1]
            customdata = point.get("customdata")
            if isinstance(customdata, list) and customdata:
                clicked_block_id = str(customdata[0])
            elif isinstance(customdata, str):
                clicked_block_id = customdata

    with st.expander("Editing Guide", expanded=False):
        st.markdown(
            """
            1. Select a block from the image or text list.
            2. Edit the transcription in the right panel.
            3. Add an optional reviewer comment.
            4. Check `Mark as done` to mark a block as reviewed.
            Changes are saved automatically when you leave a field.
            """
        )

    return clicked_block_id


def _render_inline_editor(
    block: dict[str, Any],
    block_id: str,
    block_index: int,
    current_page_index: int,
) -> None:
    path = block_path(current_page_index, block_index)
    correction = correction_for_path(path) or {}
    current_text = block.get("transcription", "")
    current_comment = correction.get("comment", "")
    current_status = block_status(current_page_index, block_index)
    editor_text_key = f"editor_text_{path}"
    done_status_key = f"done_status_{path}"
    comment_key = f"comment_{path}"

    if editor_text_key not in st.session_state:
        st.session_state[editor_text_key] = current_text
    if done_status_key not in st.session_state:
        st.session_state[done_status_key] = current_status == "done"
    if comment_key not in st.session_state:
        st.session_state[comment_key] = current_comment

    def _autosave() -> None:
        new_text = st.session_state[editor_text_key]
        new_status = "done" if st.session_state[done_status_key] else "pending"
        new_comment = st.session_state[comment_key]
        original = get_by_path(st.session_state.initial_bundle, path)
        add_or_update_correction(path, original, new_text, new_status, new_comment)
        try:
            save_bundle()
            st.toast("Saved ✓")
        except Exception as exc:
            st.error(f"Auto-save failed: {exc}")

    st.caption(f"Block ID: {block_id}")
    st.caption(f"Confidence: {round(float(block.get('confidence', 0.0)) * 100, 2)}%")
    st.caption(f"Content Unit: {block.get('content_unit_id', '')}")

    st.text_area("Transcription", key=editor_text_key, height=360, on_change=_autosave)
    st.checkbox("Mark as done", key=done_status_key, on_change=_autosave)
    st.text_area("Reviewer Comment", key=comment_key, height=80, on_change=_autosave)


def render_text_panel(
    current_page: dict[str, Any],
    selected_block_id: str | None,
    current_page_index: int,
) -> str | None:
    st.subheader("Text Editor")
    blocks = current_page.get("blocks", [])
    if not blocks:
        st.info("No blocks on this page.")
        return None

    block_ids = [b.get("id", "") for b in blocks]
    current_idx = block_ids.index(selected_block_id) if selected_block_id in block_ids else -1

    nav_prev, nav_info, nav_next = st.columns([1, 2, 1])
    with nav_prev:
        if st.button("▲ Prev", disabled=current_idx <= 0, use_container_width=True, key="nav_prev_block"):
            return block_ids[current_idx - 1]
    with nav_info:
        label = f"Block {current_idx + 1} / {len(blocks)}" if current_idx >= 0 else "Click a region on the image to start editing"
        st.markdown(
            f"<div style='text-align:center;padding:6px 0;font-size:0.9rem;'>{label}</div>",
            unsafe_allow_html=True,
        )
    with nav_next:
        if st.button(
            "▼ Next",
            disabled=current_idx < 0 or current_idx >= len(blocks) - 1,
            use_container_width=True,
            key="nav_next_block",
        ):
            return block_ids[current_idx + 1]

    st.divider()

    # --- Editor section (always visible, not inside a scrollable area) ---
    if current_idx >= 0:
        st.markdown("#### Selected Block")
        _render_inline_editor(
            blocks[current_idx], selected_block_id, current_idx, current_page_index,
        )
    else:
        st.info("Click a highlighted region on the page image or choose a block from the list below.")

    st.divider()

    # --- Block List section (scrollable) ---
    needle = st.session_state.search_term.lower().strip()
    clicked_id: str | None = None

    with st.container(height=300):
        for idx, block in enumerate(blocks):
            block_id = block.get("id", "")
            text = block.get("transcription", "")
            if needle and needle not in text.lower() and needle not in block_id.lower():
                continue

            is_selected = block_id == selected_block_id
            status = block_status(current_page_index, idx)
            status_icon = "◻" if status == "pending" else "✓"
            prefix = "▶ " if is_selected else ""

            if st.button(
                f"{prefix}{status_icon} {block_id}",
                key=f"tcard_{current_page_index}_{idx}",
                use_container_width=True,
            ):
                if not is_selected:
                    clicked_id = block_id

            snippet = html.escape(text)
            st.markdown(
                (
                    "<div style='direction:rtl;text-align:right;font-size:0.85rem;color:#64748b;"
                    "margin:-0.3rem 0 0.6rem 0;line-height:1.45;white-space:pre-wrap;'>"
                )
                + snippet
                + "</div>",
                unsafe_allow_html=True,
            )

    return clicked_id


def render_changes_log() -> None:
    st.subheader("Corrections Log")
    corrections = st.session_state.bundle.get("corrections", [])
    if not corrections:
        st.info("No corrections yet.")
        return

    sorted_corrections = sorted(corrections, key=lambda c: c.get("timestamp", ""), reverse=True)

    for c in sorted_corrections:
        path = c.get("path", "")
        m = re.search(r"pages\.(\d+)\.blocks\.(\d+)", path)
        if m:
            label = f"Page {int(m.group(1)) + 1}, Block {int(m.group(2)) + 1}"
        else:
            label = html.escape(path)

        ts_raw = c.get("timestamp", "")
        try:
            ts = datetime.fromisoformat(ts_raw).strftime("%Y-%m-%d %H:%M")
        except ValueError:
            ts = html.escape(ts_raw)

        status = c.get("status", "pending")
        color = STATUS_COLORS.get(status, "#3f3f46")
        badge = (
            f'<span style="background:{color};color:#fff;border-radius:4px;'
            f'padding:2px 8px;font-size:0.75rem;">{html.escape(status)}</span>'
        )

        original = html.escape(c.get("original", "")).replace("\n", "<br>")
        corrected = html.escape(c.get("corrected", "")).replace("\n", "<br>")
        comment = c.get("comment", "").strip()

        rtl_style = "direction:rtl;text-align:right;font-family:serif;font-size:1rem;line-height:1.6;"
        st.markdown(
            f"""
<div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;margin-bottom:12px;">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
    <strong>{label}</strong>
    <span style="color:#6b7280;font-size:0.8rem;">{ts}</span>
    {badge}
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
    <div>
      <div style="font-size:0.7rem;color:#ef4444;margin-bottom:4px;">ORIGINAL</div>
      <div style="{rtl_style}color:#ef4444;">{original}</div>
    </div>
    <div>
      <div style="font-size:0.7rem;color:#16a34a;margin-bottom:4px;">CORRECTED</div>
      <div style="{rtl_style}color:#16a34a;">{corrected}</div>
    </div>
  </div>
  {'<div style="margin-top:8px;font-size:0.85rem;color:#6b7280;">💬 ' + html.escape(comment) + '</div>' if comment else ''}
</div>
""",
            unsafe_allow_html=True,
        )


def main() -> None:
    st.set_page_config(page_title="Pruzaner Sztyme Review", layout="wide")
    st.title("Pruzaner Sztyme Review")
    st.caption("Historic Newspaper OCR Correction Tool")
    st.markdown(
        """
        <style>
        textarea[aria-label="Transcription"] {
            direction: rtl;
            text-align: right;
            font-family: "Noto Serif Hebrew", "David", "Times New Roman", serif;
            font-size: 1.07rem;
            line-height: 1.7;
        }
        textarea[aria-label="Reviewer Comment"] {
            direction: ltr;
            text-align: left;
        }
        </style>
        """,
        unsafe_allow_html=True,
    )

    initialize_state()
    load_default_assets()

    upload_col1, upload_col2, upload_col3 = st.columns([2, 2, 3])
    with upload_col1:
        with st.expander("Upload JSON", expanded=False):
            uploaded_json = st.file_uploader(
                "Upload JSON",
                type=["json"],
                key="upload_json_file",
            )
    with upload_col2:
        with st.expander("Upload PDF", expanded=False):
            uploaded_pdf = st.file_uploader(
                "Upload PDF",
                type=["pdf"],
                key="upload_pdf_file",
            )
    with upload_col3:
        if st.session_state.bundle is not None:
            st.metric("Corrections", len(st.session_state.corrections))

    if uploaded_json is not None:
        try:
            incoming_bundle = json.loads(uploaded_json.read().decode("utf-8"))
            load_bundle(incoming_bundle, f"Uploaded JSON: {uploaded_json.name}")
            st.success("Loaded uploaded JSON bundle.")
        except Exception as exc:
            st.error(f"Could not parse uploaded JSON: {exc}")

    if st.session_state.bundle is None:
        st.warning("No bundle loaded. Add data/default_bundle.json or upload a JSON file.")
        return

    pages = st.session_state.bundle.get("pages", [])
    if not pages:
        st.error("Loaded bundle has no pages.")
        return

    max_index = len(pages) - 1
    st.session_state.current_page_index = max(0, min(st.session_state.current_page_index, max_index))
    current_page = pages[st.session_state.current_page_index]

    new_page_index, selected_block_id = render_sidebar(current_page, st.session_state.current_page_index)
    if new_page_index != st.session_state.current_page_index:
        st.session_state.current_page_index = new_page_index
        st.rerun()

    current_page = pages[st.session_state.current_page_index]

    pdf_bytes = get_pdf_bytes(uploaded_pdf)
    page_png: bytes | None = None
    if pdf_bytes:
        rendered = render_pdf_pages(pdf_bytes)
        if st.session_state.current_page_index < len(rendered):
            page_png = rendered[st.session_state.current_page_index]

    col_left, col_right = st.columns([5, 4])
    with col_left:
        clicked_block_id = render_image_panel(current_page, selected_block_id, page_png, st.session_state.current_page_index)
        if clicked_block_id and clicked_block_id != st.session_state.selected_block_id:
            st.session_state.selected_block_id = clicked_block_id
            st.rerun()
    with col_right:
        if st.session_state.active_tab == "Changes Log":
            render_changes_log()
        else:
            clicked_text_block = render_text_panel(
                current_page,
                st.session_state.selected_block_id,
                st.session_state.current_page_index,
            )
            if clicked_text_block and clicked_text_block != st.session_state.selected_block_id:
                st.session_state.selected_block_id = clicked_text_block
                st.rerun()

    export_name = "pruzaner_review.json"
    edition = st.session_state.initial_bundle.get("edition", {}) if st.session_state.initial_bundle else {}
    if isinstance(edition, dict) and edition.get("date"):
        export_name = f"pruzaner_review_{edition['date']}.json"

    st.download_button(
        "Download Corrected JSON",
        data=export_bundle(),
        file_name=export_name,
        mime="application/json",
        use_container_width=True,
    )


if __name__ == "__main__":
    main()
