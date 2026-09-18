#!/usr/bin/env bash
# t6 · PPTX 门禁（pptfast validate + audit + render 可重复执行）
# pptfast 0.20.0 要求 Node >= 22.19；本机默认 node 为 20.20，必须显式切到 nvm 的 node22。
set -uo pipefail
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
SK=/root/.npm/_npx/d6400a02ac12bded/node_modules/@liustack/pptfast/skills/pptfast
cd "$(dirname "$0")/../ppt" || exit 1

echo "node: $(node -v)  (pptfast needs >=22.19)"
rm -f deck.json
python3 build_deck.py || exit 1

run() { echo "--- pptfast $1 ---"; bash "$SK/scripts/run.sh" "${@:2}"; echo "exit=$?"; }

run "spec validate" spec validate deck.spec.json
run "assemble"      assemble .
run "validate"      validate .
run "audit"         audit .
run "render"        render . -o "收储用途扩围与平台机会_正式稿.pptx" --style style.json

echo "--- pptx verify ---"
python3 - <<'PY'
from pptx import Presentation
pr = Presentation("收储用途扩围与平台机会_正式稿.pptx")
n = len(pr.slides)
notes = sum(1 for s in pr.slides if s.has_notes_slide and s.notes_slide.notes_text_frame.text.strip())
allt = "\n".join(sh.text_frame.text for s in pr.slides for sh in s.shapes
                 if sh.has_text_frame and sh.text_frame.text)
print(f"slides={n} notes={notes} 研判推断={allt.count('研判推断')} 待补={allt.count('待补')}")
PY
