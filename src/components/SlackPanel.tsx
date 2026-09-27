import { useEffect, useState } from 'react'
import type { Constraint, SlackAnalysis, TimeObservation, TEvent } from '../types'
import { analyzeUniformSlack, relaxConstraints } from '../lib/slack'
import { describeConstraint, formatFullDateTime } from '../lib/format'
import WindowsTable from './WindowsTable'
import CyclePanel from './CyclePanel'

interface Props {
  events: TEvent[]
  constraints: Constraint[]
  observations: TimeObservation[]
}

/** 解析非负整数分钟上限；非法输入返回 null */
function parseCap(text: string): number | null {
  const t = text.trim()
  if (!/^\d+$/.test(t)) return null
  const v = Number(t)
  return Number.isSafeInteger(v) && v >= 0 ? v : null
}

/** 计算时使用的输入快照：案卷或 M 改变后旧结果立即失效 */
interface SlackRun {
  events: TEvent[]
  constraints: Constraint[]
  observations: TimeObservation[]
  mText: string
  analysis: SlackAnalysis
}

/**
 * 统一宽限分析面板（独立、只读）：
 * 用户输入非负整数分钟上限 M，点击求解后利用可满足性关于 ε 的单调性二分
 * 最小整数宽限 ε（0 ≤ ε ≤ M）：每条启用证词 [min, max] 统一放宽为
 * [max(0, min−ε), max+ε]，方向保留，观测与停用证词不变。
 * 原案卷相容时 ε = 0；上限内无解时展示 ε = M 时的矛盾链。
 * 结果只读，不写入案卷或本地存储；案卷或 M 改变后旧结果自动清除。
 */
export default function SlackPanel({ events, constraints, observations }: Props) {
  const [mText, setMText] = useState('')
  const [run, setRun] = useState<SlackRun | null>(null)

  // 案卷或 M 改变后清除旧结果（结果只读，不写入案卷或本地存储）
  useEffect(() => {
    setRun((cur) =>
      cur &&
      (cur.events !== events ||
        cur.constraints !== constraints ||
        cur.observations !== observations ||
        cur.mText !== mText)
        ? null
        : cur,
    )
  }, [events, constraints, observations, mText])

  // 渲染期间同步隐藏失效结果（不等待 effect，避免闪出过期结论）
  const shown =
    run &&
    run.events === events &&
    run.constraints === constraints &&
    run.observations === observations &&
    run.mText === mText
      ? run.analysis
      : null

  const cap = parseCap(mText)
  const enabledCount = constraints.filter((c) => c.enabled).length

  const solve = () => {
    if (cap === null) return
    setRun({
      events,
      constraints,
      observations,
      mText,
      analysis: analyzeUniformSlack(events, constraints, observations, cap),
    })
  }

  return (
    <div className="panel slack-panel">
      <h3>
        统一宽限分析
        <span className="count">
          全部启用证词统一放宽 [max(0, min−ε), max+ε] · 单调二分最小 ε · 只读，不写入案卷
        </span>
      </h3>

      <div className="slack-desc">
        给定分钟上限 M，求使<strong>全部启用证词与原有观测同时相容</strong>的最小整数宽限 ε（0 ≤ ε ≤ M）：
        每条启用证词的间隔 [min, max] 统一变为 [max(0, min−ε), max+ε]（早于/晚于方向保留），
        观测与停用证词不变。利用可满足性关于 ε 的单调性二分搜索，不逐分钟枚举。
      </div>

      {events.length === 0 && (
        <div className="empty-hint">添加事件、录入证词与观测后，可进行统一宽限分析。</div>
      )}

      {events.length > 0 && (
        <div className="slack-input-row">
          <label htmlFor="slack-cap">分钟上限 M（非负整数）</label>
          <input
            id="slack-cap"
            type="number"
            min={0}
            step={1}
            className={`num${mText.trim() !== '' && cap === null ? ' invalid' : ''}`}
            style={{ width: 110 }}
            value={mText}
            placeholder="如 60"
            onChange={(e) => setMText(e.target.value)}
          />
          <button
            className="primary"
            disabled={cap === null}
            title={cap === null ? '请输入非负整数分钟上限' : `在 0 ~ ${cap} 分钟内二分最小可行宽限`}
            onClick={solve}
          >
            求解最小宽限 ε
          </button>
          {mText.trim() !== '' && cap === null && (
            <span className="slack-invalid">请输入非负整数（0、1、2 …）</span>
          )}
          <span className="slack-scope">
            当前 {enabledCount} 条启用证词参与放宽，{observations.length} 条观测保持不变
          </span>
        </div>
      )}

      {shown && (
        <SlackResultView
          analysis={shown}
          events={events}
          constraints={constraints}
          observations={observations}
        />
      )}
    </div>
  )
}

interface ResultProps {
  analysis: SlackAnalysis
  events: TEvent[]
  constraints: Constraint[]
  observations: TimeObservation[]
}

const EMPTY_SET: Set<string> = new Set()

/** 分析结果展示（成功：放宽区间 + 事件时间窗；失败：ε = M 时的矛盾链） */
export function SlackResultView({ analysis, events, constraints, observations }: ResultProps) {
  const nameOf = (id: string) => events.find((e) => e.id === id)?.name ?? '（已删除事件）'

  if (!analysis.solvable) {
    // 上限内无解：展示 ε = M 放宽系统中的一条矛盾链（证词区间已按 ε = M 放宽）
    const relaxedAtCap = relaxConstraints(constraints, analysis.cap)
    return (
      <div className="slack-result">
        <div className="schedule-note danger">
          ⛔ 上限 M = {analysis.cap} 分钟内<strong>不存在可行宽限</strong>：即使把每条启用证词统一放宽为
          [max(0, min−{analysis.cap}), max+{analysis.cap}]，系统仍然矛盾。
          以下矛盾链来自 ε = {analysis.cap} 的放宽系统（共 {analysis.probes} 次可满足性判定）；
          请核对涉及的观测与证词，或增大上限 M 后重新求解。
        </div>
        {analysis.cycleAtCap && (
          <CyclePanel
            cycle={analysis.cycleAtCap}
            events={events}
            constraints={relaxedAtCap}
            observations={observations}
          />
        )}
      </div>
    )
  }

  const eps = analysis.epsilon!
  return (
    <div className="slack-result">
      <div className="schedule-note ok">
        ✅ 最小统一宽限 <strong>ε = {eps} 分钟</strong>
        {eps === 0
          ? '：原案卷已相容，全部启用证词与原有观测无需任何宽限即可同时满足。'
          : `：把每条启用证词统一放宽为 [max(0, min−${eps}), max+${eps}] 后，全部启用证词与原有观测同时相容；ε = ${
              eps - 1
            } 时仍矛盾（已验证）。`}
        <span className="slack-probes">
          在 0 ~ {analysis.cap} 上单调二分，共 {analysis.probes} 次可满足性判定（非逐分钟枚举）。
        </span>
      </div>

      {analysis.relaxed.length > 0 && (
        <div className="slack-relaxed">
          <div className="slack-relaxed-title">
            放宽后的证词区间（{analysis.relaxed.length} 条启用证词，方向保留；停用证词不参与）：
          </div>
          <ul className="slack-relaxed-list">
            {analysis.relaxed.map((r) => (
              <li key={r.constraintId} className="slack-relaxed-item">
                <code className="order-no">#{r.order}</code>
                <span className="constraint-text">
                  {describeConstraint(
                    { aId: r.aId, bId: r.bId, relation: r.relation, min: r.min, max: r.max },
                    nameOf,
                  )}
                </span>
                <span className="slack-arrow">→</span>
                <code className="slack-range">
                  [{r.relaxedMin}, {r.relaxedMax}]
                </code>
                分钟
                {r.relaxedMin === 0 && r.min - eps < 0 && (
                  <span className="badge offlink" title="下界 min−ε 小于 0，已按 0 截断">
                    下界截断为 0
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="slack-windows">
        <div className="slack-relaxed-title">
          放宽后的事件绝对时间窗（基准 t₀ = {formatFullDateTime(analysis.baseISO)}）：
        </div>
        {analysis.baseISO === null && (
          <div className="empty-hint">
            案卷中没有任何绝对时间观测：相对系统可满足，但全部事件均<strong>无法定时</strong>
            （没有可换算绝对时刻的时间基准）。
          </div>
        )}
        <WindowsTable
          events={events}
          windows={analysis.windows}
          cycleEventIds={EMPTY_SET}
          baseISO={analysis.baseISO}
          observations={observations}
          embedded
        />
      </div>
    </div>
  )
}
