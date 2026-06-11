import type { BpRuntimeState } from '../../types/bp'

interface DisplayCenterStageProps {
  state: BpRuntimeState | null
}

function DisplayCenterStage({ state }: DisplayCenterStageProps): React.JSX.Element {
  const currentStep = state?.currentStep
  const stepText = currentStep
    ? currentStep.action === 'protect' || currentStep.action === 'borrow'
      ? `第 ${currentStep.index} 步 ${currentStep.action === 'protect' ? '保护' : '租借'}`
      : `第 ${currentStep.index} 步 ${currentStep.side === 'star' ? '左侧队' : '右侧队'} ${
          currentStep.action === 'pick' ? 'Pick' : 'Ban'
        }`
    : '等待 BP 开始'

  return (
    <main className="display-center-stage">
      <div className="display-flow-name">{state?.flowName ?? 'XQB-BPBox'}</div>
      <div className="display-step-text">{stepText}</div>
      <div className="display-effect-layer" aria-hidden="true" />
      <video className="display-chant-layer" aria-hidden="true" />
    </main>
  )
}

export default DisplayCenterStage
