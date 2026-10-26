const choices = [...document.querySelectorAll('.choice')]
const mock = document.getElementById('appMock')
const phaseTitle = document.getElementById('phaseTitle')
const phaseDetail = document.getElementById('phaseDetail')
const footerPhase = document.getElementById('footerPhase')
const composeHint = document.getElementById('composeHint')
const stages = [...document.querySelectorAll('.stage')]
const timers = []

const phases = [
  { title: '正在恢复会话', detail: '先取回会话信息，随后显示最近消息。', foot: '演示：正在读取会话信息', compose: '会话可用后即可继续提问' },
  { title: '会话已找到', detail: '标题和操作先出现，正在读取最近消息。', foot: '演示：正在读取最近消息', compose: '最近消息即将出现' },
  { title: '最近消息已显示', detail: '现在可以阅读与提问；较早消息和工作区按需打开。', foot: '演示：最近消息可用', compose: '输入新的问题或继续对话' },
  { title: '可以继续提问', detail: '工作区在打开时再读取，不必等待全部内容。', foot: '演示完成：会话已可用', compose: '输入新的问题或继续对话' },
]

function showPhase(index) {
  const phase = phases[index]
  mock.dataset.phase = index >= 2 ? index === 3 ? '3' : '2' : String(index)
  phaseTitle.textContent = phase.title
  phaseDetail.textContent = phase.detail
  footerPhase.textContent = phase.foot
  composeHint.textContent = phase.compose
  stages.forEach((stage, stageIndex) => {
    stage.classList.toggle('isDone', stageIndex < Math.min(index, 2))
    stage.classList.toggle('isActive', stageIndex === index && index < 2)
  })
}

function replay() {
  for (const timer of timers) clearTimeout(timer)
  timers.length = 0
  showPhase(0)
  timers.push(setTimeout(() => showPhase(1), 1250))
  timers.push(setTimeout(() => showPhase(2), 2850))
  timers.push(setTimeout(() => showPhase(3), 4400))
}

for (const choice of choices) choice.addEventListener('click', () => {
  const style = choice.dataset.style
  if (style === mock.dataset.style) return replay()
  mock.dataset.style = style
  for (const other of choices) {
    const selected = other === choice
    other.classList.toggle('isSelected', selected)
    other.setAttribute('aria-pressed', String(selected))
  }
  replay()
})

document.getElementById('replay').addEventListener('click', replay)
replay()
