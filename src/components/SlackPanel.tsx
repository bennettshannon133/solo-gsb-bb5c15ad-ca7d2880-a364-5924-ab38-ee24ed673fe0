import { useEffect, useState } from 'react'
import type { Constraint, SlackAnalysis, TimeObservation, TEvent } from '../types'
import { computeUniformSlack } from '../lib/slack'
import { describeConstraint } from '../lib/format'
import CyclePanel from './CyclePanel'
import WindowsTable from './WindowsTable'

interface Props {
  events: TEvent[]
  constraints: Constraint[]
  observations: TimeObservation[]
}

/** 解析上限输入：非负整数（安全整数）才有效；空串与其余输入一律无效 */
function parseCap(text: string): number | null {
  const t = text.trim()
  if (!/^\d+$/.test(t)) return null
  const n = Number(t)
  return Number.isSafeInteger(n) ? n : null
}

/** 一次已完成的分析：结果与产生它的案卷引用、上限绑定，用于失配时清除 */
export interface SlackRun {
  events: TEvent[]
  constraints: Constraint[]
  observations: TimeObservation[]
  cap: number
  result: SlackAnalysis
}

const EMPTY_SET: Set<string> = new Set()

/**
 * 统一宽限分析结果视图（只读展示）：
 * 成功时给出最小宽限 ε、放宽后的证词区间与事件时间窗；
 * 上限内无解时展示 ε = M 时的矛盾链。
 */
export function SlackResultView({ run }: { run: SlackRun }) {
  const { result } = run
  const nameById = new Map(run.events.map((e) => [e.id, e.name]))
  const nameOf = (id: string) => nameById.get(id) ?? '（已删除事件）'
  const orderOf = new Map(run.constraints.map((c, i) => [c.id, i + 1]))
  const constraintById = new Map(run.constraints.map((c) => [c.id, c]))
  const eps = result.epsilon

  return (
    <div className="slack-result">
      {eps !== null ? (
        <>
          <div className="schedule-note ok">
            ✅ 最小统一宽限 <strong>ε = {eps} 分钟</strong>（0 ≤ ε ≤ M = {result.cap}）。
            {eps === 0
              ? '原案卷的全部启用证词与观测已同时相容，无需宽限。'
              : `每条启用证词的间隔已统一放宽为 [max(0, min−${eps}), max+${eps}]，早于/晚于方向不变。`}
            观测与停用证词保持不变。
          </div>

          {result.relaxed.length > 0 ? (
            <>
              <div className="slack-subtitle">
                放宽后的证词区间（{result.relaxed.length} 条启用证词，按录入顺序）：
              </div>
              <div className="slack-relax-list">
                {result.relaxed.map((r) => {
                  const c = constraintById.get(r.constraintId)
                  if (!c) return null
                  // 下界被 max(0, min−ε) 截断（仅当原下界为正且被压到 0 时标注）
                  const clamped = c.min > 0 && c.min - eps < 0
                  return (
                    <div className="slack-relax-item" key={r.constraintId}>
                      <code className="order-no">#{orderOf.get(r.constraintId)}</code>
                      <span className="slack-relax-text">{describeConstraint(c, nameOf)}</span>
                      <span className="slack-arrow">→</span>
                      <code className="slack-interval">
                        [{r.min}, {r.max}] 分钟
                      </code>
                      {clamped && (
                        <span
                          className="badge invalid-badge"
                          title={`下界 max(0, ${c.min}−${eps}) 已在 0 处截断`}
                        >
                          下界截断于 0
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          ) : (
            <div className="empty-hint">
              当前没有启用中的证词：统一宽限只作用于启用证词的区间，观测与停用证词不受影响。
            </div>
          )}

          <div className="slack-subtitle">ε = {eps} 放宽后的事件时间窗：</div>
          {result.baseISO === null && (
            <div className="schedule-note warn">
              🎯 案卷中没有任何绝对时间观测：放宽后的系统可满足，但缺少绝对时间基准，
              全部事件均标注为「无法定时」。
            </div>
          )}
          <WindowsTable
            events={run.events}
            windows={result.windows}
            cycleEventIds={EMPTY_SET}
            baseISO={result.baseISO}
            observations={run.observations}
            embedded
          />
        </>
      ) : (
        <>
          <div className="schedule-note danger">
            ⛔ 上限内无解：ε = M = {result.cap} 分钟时，放宽后的启用证词与原有观测仍相互矛盾。
            下面给出 ε = {result.cap} 时统一差分图中的一条矛盾链（证词区间已按 ε 放宽）——
            需要更大的上限、停用可疑证词，或核对观测记录。
          </div>
          {result.cycle && (
            <CyclePanel
              cycle={result.cycle}
              events={run.events}
              constraints={result.relaxedConstraints}
              observations={run.observations}
            />
          )}
        </>
      )}
      <div className="slack-readonly">
        分析结果只读：不写入案卷或浏览器本地存储；案卷或上限 M 改变后结果自动清除。
      </div>
    </div>
  )
}

/**
 * 统一宽限分析面板：输入非负整数分钟上限 M，求使全部启用证词与原有观测
 * 同时相容的最小整数宽限 ε（0 ≤ ε ≤ M）。手动触发、结果只读；
 * 案卷或 M 改变后旧结果自动清除。
 */
export default function SlackPanel({ events, constraints, observations }: Props) {
  const [capText, setCapText] = useState('60')
  const [run, setRun] = useState<SlackRun | null>(null)

  const cap = parseCap(capText)
  const invalid = capText.trim() !== '' && cap === null

  // 案卷或 M 改变后清除旧结果：案卷数据不可变更新，引用比较即可发现变化
  const stale =
    run !== null &&
    (run.events !== events ||
      run.constraints !== constraints ||
      run.observations !== observations ||
      run.cap !== cap)
  useEffect(() => {
    if (stale) setRun(null)
  }, [stale])
  const shown = stale ? null : run

  const activeCount = constraints.filter((c) => c.enabled).length

  const runAnalysis = () => {
    if (cap === null || events.length === 0) return
    setRun({
      events,
      constraints,
      observations,
      cap,
      result: computeUniformSlack(events, constraints, observations, cap),
    })
  }

  return (
    <div className="panel slack-panel">
      <h3>
        统一宽限分析
        <span className="count">
          {activeCount} 条启用证词 · {observations.length} 条观测 · 结果只读
        </span>
      </h3>

      <div className="slack-desc">
        给定上限 M，求使<strong>全部启用证词与原有观测同时相容</strong>的最小整数宽限
        ε（0 ≤ ε ≤ M）：每条启用证词的间隔 [min, max] 统一变为
        [max(0, min−ε), max+ε]，早于/晚于方向不变，观测与停用证词不变。
        利用可满足性关于 ε 的单调性二分搜索（不逐分钟枚举）；
        原案卷相容时 ε = 0，上限内无解时展示 ε = M 的矛盾链。
      </div>

      {events.length === 0 ? (
        <div className="empty-hint">添加事件、证词与观测后，可进行统一宽限分析。</div>
      ) : (
        <>
          <div className="add-row slack-input-row">
            <label>
              宽限上限 M（分钟，非负整数）
              <input
                className={`num${invalid ? ' invalid' : ''}`}
                value={capText}
                onChange={(e) => setCapText(e.target.value)}
                inputMode="numeric"
                placeholder="如 60"
                aria-label="宽限上限 M（分钟）"
              />
            </label>
            <button className="primary" disabled={cap === null} onClick={runAnalysis}>
              开始分析
            </button>
            {shown && <span className="slack-stale-hint">修改案卷或 M 后结果自动清除</span>}
          </div>
          {invalid && (
            <div className="slack-error">M 必须是非负整数分钟（0、1、2 …），当前输入无法解析。</div>
          )}
          {shown && <SlackResultView run={shown} />}
        </>
      )}
    </div>
  )
}
