#!/usr/bin/env python3
"""检查 deck workspace 的关键目录、核心输入与轻量合同是否齐全。

定位与作用
----------
这个脚本不判断页面美不美，而是判断 workspace 是否具备继续工作的最低条件。
它默认检查新的精简 workspace：`brief.md + deck_narrative.md + data/assets/build/validation/final`。
如果检测到旧的 `brief/ plan/ content/` 结构，会给出迁移 warning，但不会静默把旧结构当成新默认。

开启 `--check-contract` 后，脚本会轻量检查 `build/generated/slide_specs.yaml`：
deck mapping、theme_tokens、slide 必填字段、枚举值、asset slot 字段、module/backend/status/validation 的一致性。
它不是重型 schema validator，目标是提前暴露会让 build 或验证链路漂移的明显问题。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import yaml

from agent_qc_reminders import build_agent_reminder
from agent_qc_reminders import make_observation
from agent_qc_reminders import scan_source_font_size_literals
from agent_qc_reminders import sidecar_path
from agent_qc_reminders import write_agent_reminder


REQUIRED_DIRS = ("data", "assets", "build", "validation", "final")
REQUIRED_FILES = ("brief.md", "deck_narrative.md")
LEGACY_HINT_DIRS = ("brief", "plan", "content")

ASSET_DIRS = (
    "diagrams",
    "charts",
    "icons",
    "images",
    "tables",
)

REQUIRED_SLIDE_FIELDS = (
    "title",
    "reader_question",
    "page_task",
    "reading_mode",
    "archetype",
    "asset_mode",
    "validation_mode",
    "key_message",
)

ALLOWED_PAGE_TASKS = {"persuade", "explain", "compare", "evidence", "archive"}
ALLOWED_READING_MODES = {"scan", "decision", "guided", "reference"}
ALLOWED_ASSET_MODES = {
    "text-layout-native",
    "diagram-connector",
    "diagram-visual",
    "office-chart-native",
    "python-figure-image",
    "table-native",
    "image-generation",
    "image-hero",
    "icon-accent",
    "mixed",
}
ALLOWED_VALIDATION_MODES = {
    "preview_only",
    "diagram_connector",
    "diagram_visual",
    "chart_editable",
    "chart_image",
    "table_native",
    "image_generated",
    "template_locked",
}
ALLOWED_SLOT_STATUSES = {
    "planned",
    "ready",
    "generated",
    "pending_user_generation",
    "inserted",
    "validated",
    "blocked",
}
MODULE_VALIDATION_MODES = {
    "text-layout-native": {"preview_only"},
    "diagram-connector": {"diagram_connector"},
    "diagram-visual": {"diagram_visual", "preview_only"},
    "office-chart-native": {"chart_editable"},
    "python-figure-image": {"chart_image"},
    "table-native": {"table_native", "preview_only"},
    "image-generation": {"image_generated"},
    "image-hero": {"preview_only", "image_generated"},
    "icon-accent": {"preview_only"},
}
MODULE_BACKENDS = {
    "text-layout-native": {"python-pptx"},
    "diagram-connector": {"python-pptx"},
    "diagram-visual": {"python-pptx", "mermaid", "manual"},
    "office-chart-native": {"python-pptx"},
    "python-figure-image": {"matplotlib", "seaborn", "python"},
    "table-native": {"python-pptx"},
    "image-generation": {"gpt-image-api", "manual-web", "external-image"},
    "image-hero": {"python-pptx", "external-image"},
    "icon-accent": {"icon-registry", "pymupdf"},
}
PROFILE_FIELDS = {
    "source_context": {"template_locked", "template_guided", "content_migration", "brand_assets_only", "no_template"},
    "delivery_context": {
        "self-contained_reading_deck",
        "speaker-led_stage_deck",
        "hybrid_review_deck",
        "reference_or_appendix_deck",
    },
    "communication_profile": {"business_report", "technical_explainer", "research_review", "keynote_story"},
    "visual_profile": {"corporate_clear", "editorial_ink", "swiss_modernist", "product_launch"},
    "density_profile": {"dense_reference", "balanced_brief", "low_density_stage"},
    "editability_profile": {"fully_editable", "chart_editable", "mixed_assets", "snapshot_allowed"},
}
REQUIRED_THEME_TOKEN_FIELDS = (
    "typography_profile",
    "page_width_in",
    "page_height_in",
    "hero_title_font_pt",
    "section_title_font_pt",
    "page_title_font_pt",
    "subtitle_font_pt",
    "minor_title_font_pt",
    "body_font_pt",
    "label_font_pt",
    "caption_font_pt",
    "title_line_spacing_multiple",
    "body_line_spacing_multiple",
    "title_paragraph_space_lines",
    "body_first_line_indent_chars",
    "body_paragraph_space_lines",
    "latin_font_name",
    "east_asia_font_name",
    "table_font_pt",
    "table_line_spacing_multiple",
    "table_paragraph_space_lines",
    "table_first_line_indent_chars",
    "table_vertical_anchor",
    "table_header_alignment",
    "table_index_alignment",
    "table_text_alignment",
    "table_numeric_alignment",
    "left_margin_in",
    "right_margin_in",
)
NUMERIC_THEME_TOKEN_RANGES = {
    "page_width_in": (10.0, 16.0),
    "page_height_in": (5.0, 10.0),
    "hero_title_font_pt": (28.0, 60.0),
    "section_title_font_pt": (24.0, 44.0),
    "page_title_font_pt": (20.0, 32.0),
    "subtitle_font_pt": (14.0, 22.0),
    "minor_title_font_pt": (12.0, 20.0),
    "body_font_pt": (12.0, 18.0),
    "label_font_pt": (10.5, 14.0),
    "caption_font_pt": (9.0, 12.0),
    "title_line_spacing_multiple": (0.9, 1.25),
    "body_line_spacing_multiple": (1.15, 1.8),
    "title_paragraph_space_lines": (0.0, 1.0),
    "body_first_line_indent_chars": (0.0, 2.0),
    "body_paragraph_space_lines": (0.0, 1.0),
    "table_font_pt": (10.5, 14.0),
    "table_line_spacing_multiple": (1.0, 1.4),
    "table_paragraph_space_lines": (0.0, 0.5),
    "table_first_line_indent_chars": (0.0, 0.0),
    "left_margin_in": (0.0, 2.0),
    "right_margin_in": (6.0, 16.0),
}
ALIGNMENT_TOKEN_VALUES = {
    "table_vertical_anchor": {"middle"},
    "table_header_alignment": {"center"},
    "table_index_alignment": {"left"},
    "table_text_alignment": {"left"},
    "table_numeric_alignment": {"right"},
}
FONT_SIZE_TOKEN_FIELDS = tuple(field for field in REQUIRED_THEME_TOKEN_FIELDS if field.endswith("_font_pt"))
DEFAULT_ZH_FONT_TOKEN_FALLBACKS = {
    "hero_title_font_pt": 40.0,
    "section_title_font_pt": 30.0,
    "page_title_font_pt": 24.0,
    "subtitle_font_pt": 16.0,
    "minor_title_font_pt": 14.0,
    "body_font_pt": 12.0,
    "label_font_pt": 10.5,
    "caption_font_pt": 9.0,
    "table_font_pt": 10.5,
}
FONT_SIZE_GRID_PT = 0.5
FONT_SIZE_GRID_TOLERANCE_PT = 0.02


def parse_args() -> argparse.Namespace:
    """解析命令行参数。"""
    parser = argparse.ArgumentParser(description="检查 deck workspace 的关键目录、输入与轻量合同")
    parser.add_argument("--workspace-dir", required=True, type=Path, help="deck workspace 路径")
    parser.add_argument("--json-out", type=Path, help="可选：写出 lint 结果 JSON")
    parser.add_argument("--check-contract", action="store_true", help="检查 build/generated/slide_specs.yaml 的轻量合同")
    return parser.parse_args()


def _as_list(value: object) -> list:
    """把 YAML 字段规整成 list，用于轻量校验。"""
    return value if isinstance(value, list) else []


def _append_enum_error(errors: list[str], label: str, value: object, allowed_values: set[str]) -> None:
    """检查枚举值是否合法。"""
    if value is None:
        return
    if not isinstance(value, str) or value not in allowed_values:
        allowed = ", ".join(sorted(allowed_values))
        errors.append(f"{label}: 非法值 {value!r}，允许值: {allowed}")


def lint_theme_tokens(theme_tokens: object, errors: list[str], warnings: list[str]) -> None:
    """检查 deck 级 typography 与 table token 是否足够完整。"""
    if not isinstance(theme_tokens, dict):
        errors.append("deck.theme_tokens 必须是 mapping")
        return

    missing = [field for field in REQUIRED_THEME_TOKEN_FIELDS if field not in theme_tokens]
    if missing:
        errors.append("deck.theme_tokens 缺少字段: " + ", ".join(missing))

    for field, (minimum, maximum) in NUMERIC_THEME_TOKEN_RANGES.items():
        value = theme_tokens.get(field)
        if value is None:
            continue
        if not isinstance(value, (int, float)):
            errors.append(f"deck.theme_tokens.{field}: 必须是数字")
            continue
        numeric_value = float(value)
        if numeric_value < minimum:
            errors.append(f"deck.theme_tokens.{field}: {numeric_value:g} 低于最低值 {minimum:g}")
        elif numeric_value > maximum:
            warnings.append(f"deck.theme_tokens.{field}: {numeric_value:g} 高于常规上限 {maximum:g}，请确认是有意放大")

    irregular_font_tokens: list[str] = []
    for field in FONT_SIZE_TOKEN_FIELDS:
        value = theme_tokens.get(field)
        if not isinstance(value, (int, float)):
            continue
        numeric_value = float(value)
        nearest_value = round(numeric_value / FONT_SIZE_GRID_PT) * FONT_SIZE_GRID_PT
        if abs(numeric_value - nearest_value) > FONT_SIZE_GRID_TOLERANCE_PT:
            irregular_font_tokens.append(f"{field}={numeric_value:g}pt→{nearest_value:g}pt")
    if irregular_font_tokens:
        warnings.append(
            "font_size_off_half_point_grid: "
            + ", ".join(irregular_font_tokens)
            + "；优先使用 0.5pt 网格，模板例外需记录理由"
        )

    for field in ("latin_font_name", "east_asia_font_name", "typography_profile"):
        value = theme_tokens.get(field)
        if value is not None and (not isinstance(value, str) or not value.strip()):
            errors.append(f"deck.theme_tokens.{field}: 必须是非空字符串")

    for field, allowed in ALIGNMENT_TOKEN_VALUES.items():
        value = theme_tokens.get(field)
        if value is not None and value not in allowed:
            allowed_text = ", ".join(sorted(allowed))
            errors.append(f"deck.theme_tokens.{field}: 非法值 {value!r}，允许值: {allowed_text}")

    domain_profile = theme_tokens.get("domain_profile")
    if domain_profile is not None and not isinstance(domain_profile, str):
        errors.append("deck.theme_tokens.domain_profile: 必须是字符串或 null")

    left_margin = theme_tokens.get("left_margin_in")
    right_margin = theme_tokens.get("right_margin_in")
    page_width = theme_tokens.get("page_width_in")
    if isinstance(left_margin, (int, float)) and isinstance(right_margin, (int, float)) and right_margin <= left_margin:
        errors.append("deck.theme_tokens.right_margin_in: 必须大于 left_margin_in")
    if isinstance(right_margin, (int, float)) and isinstance(page_width, (int, float)) and right_margin > page_width:
        errors.append("deck.theme_tokens.right_margin_in: 不能大于 page_width_in")


def lint_asset_slot(
    slot: object,
    *,
    slide_label: str,
    index: int,
    workspace_dir: Path,
    errors: list[str],
    warnings: list[str],
) -> None:
    """检查单个 asset_slot 的字段、状态和 module/backend/validation 搭配。"""
    if not isinstance(slot, dict):
        errors.append(f"{slide_label}.asset_slots[{index}]: 必须是 mapping")
        return

    slot_label = f"{slide_label}.asset_slots[{index}]"
    for field in ("slot_id", "asset_type", "module", "validation_mode", "status"):
        if field not in slot:
            errors.append(f"{slot_label}: 缺少字段 {field}")

    module = slot.get("module")
    backend = slot.get("backend")
    validation_mode = slot.get("validation_mode")
    status = slot.get("status")

    _append_enum_error(errors, f"{slot_label}.module", module, set(MODULE_VALIDATION_MODES))
    _append_enum_error(errors, f"{slot_label}.status", status, ALLOWED_SLOT_STATUSES)
    _append_enum_error(errors, f"{slot_label}.validation_mode", validation_mode, ALLOWED_VALIDATION_MODES)

    if isinstance(module, str) and isinstance(validation_mode, str):
        allowed_validation = MODULE_VALIDATION_MODES.get(module, set())
        if validation_mode not in allowed_validation:
            allowed = ", ".join(sorted(allowed_validation))
            errors.append(f"{slot_label}: module={module} 与 validation_mode={validation_mode} 不匹配，应为: {allowed}")

    if isinstance(module, str) and backend is not None:
        allowed_backends = MODULE_BACKENDS.get(module, set())
        if not isinstance(backend, str) or backend not in allowed_backends:
            allowed = ", ".join(sorted(allowed_backends))
            errors.append(f"{slot_label}: module={module} 与 backend={backend!r} 不匹配，应为: {allowed}")

    input_files = _as_list(slot.get("input_files"))
    output_files = _as_list(slot.get("output_files"))
    for path_text in input_files:
        if isinstance(path_text, str) and not (workspace_dir / path_text).exists():
            warnings.append(f"{slot_label}: input_file 不存在: {path_text}")

    if status in {"generated", "inserted", "validated"} and not output_files:
        errors.append(f"{slot_label}: status={status} 时必须登记 output_files")

    if status == "validated" and "validation_evidence" not in slot:
        warnings.append(f"{slot_label}: status=validated 但缺少 validation_evidence")

    if module == "image-generation":
        if backend == "manual-web" and status == "planned":
            warnings.append(f"{slot_label}: manual-web 生图通常应进入 pending_user_generation，除非 prompt 还未写出")
        if backend == "manual-web" and status == "pending_user_generation" and not input_files:
            warnings.append(f"{slot_label}: pending_user_generation 应登记 prompt 文档 input_files")
        if backend == "gpt-image-api" and status == "pending_user_generation":
            warnings.append(f"{slot_label}: gpt-image-api 不应停在 pending_user_generation，应使用 planned/ready/generated/blocked 等状态")
        if backend == "gpt-image-api" and status in {"generated", "inserted", "validated"} and "validation_evidence" not in slot:
            warnings.append(f"{slot_label}: gpt-image-api 已生成图片时应登记 metadata JSON 到 validation_evidence")
        if status == "pending_user_generation" and output_files:
            warnings.append(f"{slot_label}: pending_user_generation 已有 output_files，建议更新为 generated 或 inserted")


def lint_slide_specs(workspace_dir: Path, errors: list[str], warnings: list[str]) -> dict:
    """检查派生 slide_specs.yaml 的轻量合同。"""
    specs_path = workspace_dir / "build" / "generated" / "slide_specs.yaml"
    result = {
        "path": str(specs_path),
        "exists": specs_path.exists(),
        "slides": 0,
        "asset_slots": 0,
    }
    if not specs_path.exists():
        warnings.append("跳过合同检查：缺少 build/generated/slide_specs.yaml")
        return result

    try:
        loaded = yaml.safe_load(specs_path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        errors.append(f"slide_specs.yaml YAML 解析失败: {exc}")
        return result

    if not isinstance(loaded, dict):
        errors.append("slide_specs.yaml 顶层必须是 mapping")
        return result

    deck = loaded.get("deck")
    if not isinstance(deck, dict):
        errors.append("slide_specs.yaml 缺少 deck mapping")
    else:
        for field, allowed in PROFILE_FIELDS.items():
            _append_enum_error(errors, f"deck.{field}", deck.get(field), allowed)
        theme_tokens = deck.get("theme_tokens")
        if theme_tokens is None:
            errors.append("deck 缺少 theme_tokens；正式 deck 必须先锁定字体、字号和表格 token")
        else:
            lint_theme_tokens(theme_tokens, errors, warnings)

    slides = loaded.get("slides")
    if not isinstance(slides, list):
        errors.append("slide_specs.yaml 缺少 slides list")
        return result

    result["slides"] = len(slides)
    seen_slide_ids: set[str] = set()
    for slide_index, slide in enumerate(slides, start=1):
        slide_label = f"slides[{slide_index}]"
        if not isinstance(slide, dict):
            errors.append(f"{slide_label}: 必须是 mapping")
            continue

        slide_id = slide.get("slide_id", f"#{slide_index}")
        if isinstance(slide_id, str):
            if slide_id in seen_slide_ids:
                errors.append(f"{slide_label}: slide_id 重复: {slide_id}")
            seen_slide_ids.add(slide_id)
            slide_label = f"{slide_id}"

        missing = [field for field in REQUIRED_SLIDE_FIELDS if field not in slide]
        if missing:
            errors.append(f"{slide_label}: 缺少字段 {', '.join(missing)}")

        _append_enum_error(errors, f"{slide_label}.page_task", slide.get("page_task"), ALLOWED_PAGE_TASKS)
        _append_enum_error(errors, f"{slide_label}.reading_mode", slide.get("reading_mode"), ALLOWED_READING_MODES)
        _append_enum_error(errors, f"{slide_label}.asset_mode", slide.get("asset_mode"), ALLOWED_ASSET_MODES)
        _append_enum_error(errors, f"{slide_label}.validation_mode", slide.get("validation_mode"), ALLOWED_VALIDATION_MODES)

        asset_slots = slide.get("asset_slots")
        if asset_slots is None:
            continue
        if not isinstance(asset_slots, list):
            errors.append(f"{slide_label}.asset_slots: 必须是 list")
            continue
        result["asset_slots"] += len(asset_slots)
        for slot_index, slot in enumerate(asset_slots):
            lint_asset_slot(
                slot,
                slide_label=slide_label,
                index=slot_index,
                workspace_dir=workspace_dir,
                errors=errors,
                warnings=warnings,
            )

    return result


def collect_source_font_size_observations(workspace_dir: Path) -> list[dict]:
    """扫描 PPT workspace 源文件和构建配置中的显式字号 literal。"""

    candidate_paths: list[Path] = []
    for name in ("brief.md", "deck_narrative.md"):
        path = workspace_dir / name
        if path.exists():
            candidate_paths.append(path)
    specs_path = workspace_dir / "build" / "generated" / "slide_specs.yaml"
    if specs_path.exists():
        candidate_paths.append(specs_path)
    for dirname in ("build", "scripts"):
        root = workspace_dir / dirname
        if root.exists():
            candidate_paths.extend(
                path
                for path in root.rglob("*")
                if path.is_file() and path.suffix in {".py", ".json", ".yaml", ".yml", ".md"}
            )

    theme_tokens = load_theme_tokens(workspace_dir)
    return scan_source_font_size_literals(
        sorted(set(candidate_paths)),
        skill="ppt-polished-deck-collab",
        gate="workspace_lint",
        artifact_root=workspace_dir,
        active_tokens=ppt_font_token_map(theme_tokens),
        typography_language=ppt_typography_language(theme_tokens),
        detector_id="ppt.source.font_size_literal",
    )


def load_theme_tokens(workspace_dir: Path) -> dict:
    """从派生 slide_specs.yaml 中读取 active PPT theme tokens。"""

    specs_path = workspace_dir / "build" / "generated" / "slide_specs.yaml"
    if not specs_path.exists():
        return {}
    try:
        loaded = yaml.safe_load(specs_path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError:
        return {}
    if not isinstance(loaded, dict):
        return {}
    deck = loaded.get("deck")
    if not isinstance(deck, dict):
        return {}
    tokens = deck.get("theme_tokens")
    return tokens if isinstance(tokens, dict) else {}


def ppt_font_token_map(theme_tokens: dict) -> dict:
    """从 active PPT theme tokens 生成 source detector 使用的字号 token。"""

    result = dict(theme_tokens)
    result["recommendation_source"] = "active_ppt_theme_tokens"
    result["typography_language"] = ppt_typography_language(theme_tokens)
    for field in FONT_SIZE_TOKEN_FIELDS:
        if field in result:
            result[f"{field}__token"] = f"theme_tokens.{field}"
            if result.get("typography_language") == "zh" and field in DEFAULT_ZH_FONT_TOKEN_FALLBACKS:
                result[f"{field}__fallback_value_pt"] = DEFAULT_ZH_FONT_TOKEN_FALLBACKS[field]
    return result


def ppt_typography_language(theme_tokens: dict) -> str | None:
    """根据 typography_profile 和字体槽位推断 PPT 排版语言。"""

    profile = str(theme_tokens.get("typography_profile") or "")
    east_asia = str(theme_tokens.get("east_asia_font_name") or "")
    if profile.startswith("zh") or "宋" in east_asia or "黑" in east_asia or "楷" in east_asia or "微软雅黑" in east_asia:
        return "zh"
    if profile.startswith("en"):
        return "en"
    return None


def workspace_lint_observations(
    *,
    workspace_dir: Path,
    errors: list[str],
    warnings: list[str],
    source_font_size_observations: list[dict],
) -> list[dict]:
    """把 workspace lint 的错误、警告和 source 字号事实合并成统一 observation。"""

    observations: list[dict] = []
    artifact = {"path": str(workspace_dir)}
    detector = {"id": "ppt.workspace_lint", "layer": "source", "method": "workspace_contract_lint", "version": "1.0"}
    for index, message in enumerate(errors, start=1):
        observations.append(
            make_observation(
                code="workspace_lint_error",
                severity="error",
                message=message,
                suggested_fix="修复 workspace 输入或 slide_specs 合同后重跑 workspace lint。",
                source={"skill": "ppt-polished-deck-collab", "gate": "workspace_lint"},
                detector=detector,
                artifact=artifact,
                location={"kind": "source_issue", "index": index},
                details={"raw_message": message},
            )
        )
    for index, message in enumerate(warnings, start=1):
        observations.append(
            make_observation(
                code="workspace_lint_warning",
                severity="warning",
                message=message,
                suggested_fix="如影响构建或交付质量，修复后重跑；确认为可接受时在 review note 说明。",
                source={"skill": "ppt-polished-deck-collab", "gate": "workspace_lint"},
                detector=detector,
                artifact=artifact,
                location={"kind": "source_issue", "index": index},
                details={"raw_message": message},
            )
        )
    observations.extend(source_font_size_observations)
    return observations


def main() -> int:
    """执行 workspace lint。"""
    args = parse_args()
    workspace_dir = args.workspace_dir.resolve()

    if not workspace_dir.exists():
        raise SystemExit(f"workspace 不存在: {workspace_dir}")

    errors: list[str] = []
    warnings: list[str] = []

    required_dir_status: dict[str, bool] = {}
    for name in REQUIRED_DIRS:
        ok = (workspace_dir / name).is_dir()
        required_dir_status[name] = ok
        if not ok:
            errors.append(f"缺少目录: {name}/")

    required_file_status: dict[str, bool] = {}
    for name in REQUIRED_FILES:
        ok = (workspace_dir / name).is_file()
        required_file_status[name] = ok
        if not ok:
            errors.append(f"缺少文件: {name}")

    derived_specs_ok = (workspace_dir / "build" / "generated" / "slide_specs.yaml").exists()
    if not derived_specs_ok:
        warnings.append("缺少 build/generated/slide_specs.yaml，可由 derive_slide_specs_from_narrative.py 派生")

    legacy_dirs = [name for name in LEGACY_HINT_DIRS if (workspace_dir / name).exists()]
    if legacy_dirs:
        warnings.append("检测到 legacy 文档层: " + ", ".join(f"{name}/" for name in legacy_dirs))

    asset_counts: dict[str, int] = {}
    assets_dir = workspace_dir / "assets"
    for name in ASSET_DIRS:
        subdir = assets_dir / name
        if subdir.is_dir():
            asset_counts[name] = sum(1 for path in subdir.iterdir() if path.is_file())
        else:
            asset_counts[name] = 0
            warnings.append(f"缺少 assets/{name}/ 或该目录为空")

    contract_result = None
    if args.check_contract:
        contract_result = lint_slide_specs(workspace_dir, errors, warnings)
    source_font_size_observations = collect_source_font_size_observations(workspace_dir)

    result = {
        "workspace": str(workspace_dir),
        "required_dirs": required_dir_status,
        "required_files": required_file_status,
        "derived_slide_specs": derived_specs_ok,
        "contract_check": contract_result,
        "legacy_dirs": legacy_dirs,
        "asset_counts": asset_counts,
        "source_font_size_observations": source_font_size_observations,
        "source_font_size_warning_count": len(source_font_size_observations),
        "errors": errors,
        "warnings": warnings,
    }
    json_out = args.json_out or workspace_dir / "validation" / "workspace_lint" / "workspace_lint.json"
    observations = workspace_lint_observations(
        workspace_dir=workspace_dir,
        errors=errors,
        warnings=warnings,
        source_font_size_observations=source_font_size_observations,
    )

    print(f"[INFO] workspace={workspace_dir}")
    print("[INFO] required_files=" + ", ".join(f"{k}:{v}" for k, v in required_file_status.items()))
    print(f"[INFO] derived_slide_specs={derived_specs_ok}")
    print("[INFO] asset_counts=" + ", ".join(f"{k}:{v}" for k, v in asset_counts.items()))
    if contract_result is not None:
        print(
            "[INFO] contract_check="
            + f"exists:{contract_result['exists']} slides:{contract_result['slides']} asset_slots:{contract_result['asset_slots']}"
        )
    print(f"[INFO] source_font_size_warnings={len(source_font_size_observations)}")

    for warning in warnings:
        print(f"[WARN] {warning}")
    for error in errors:
        print(f"[ERROR] {error}")

    if json_out:
        json_out.parent.mkdir(parents=True, exist_ok=True)
        json_out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[INFO] 写入 JSON: {json_out}")
        reminder = build_agent_reminder(
            observations,
            source={"skill": "ppt-polished-deck-collab", "gate": "workspace_lint"},
            artifact={"path": str(workspace_dir)},
            full_report_ref=str(json_out),
            target_milestone="build",
        )
        agent_json_out = sidecar_path(json_out, ".json")
        agent_md_out = sidecar_path(json_out.with_suffix(".md"), ".md")
        write_agent_reminder(json_path=agent_json_out, md_path=agent_md_out, reminder=reminder)
        print(f"[INFO] agent_reminder_json={agent_json_out}")
        print(f"[INFO] agent_reminder_markdown={agent_md_out}")
        print(f"[INFO] agent_reminder_decision={reminder['decision']['state']}")

    if errors:
        print(f"[FAIL] workspace lint 未通过，错误数: {len(errors)}")
        return 1

    print("[OK] workspace lint 通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
