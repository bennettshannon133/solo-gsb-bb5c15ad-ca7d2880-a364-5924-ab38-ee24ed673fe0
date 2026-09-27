import type {
  Constraint,
  RelaxedConstraintInfo,
  SlackAnalysis,
  TimeObservation,
  TEvent,
} from '../types'
import { analyze } from './graph'

/**
 * 统一宽限放宽：把每条**启用**证词的间隔 [min, max] 统一变为
 * [max(0, min−ε), max+ε]（早于/晚于方向保留）；停用证词与观测不变。
 * ε = 0 时返回原数组（区间不变）。
 */
export function relaxConstraints(constraints: Constraint[], epsilon: number): Constraint[] {
  if (epsilon <= 0) return constraints
  return constraints.map((c) =>
    c.enabled ? { ...c, min: Math.max(0, c.min - epsilon), max: c.max + epsilon } : c,
  )
}

/** 启用证词的放宽区间清单（按约束录入顺序，仅展示用） */
function relaxedList(constraints: Constraint[], epsilon: number): RelaxedConstraintInfo[] {
  const list: RelaxedConstraintInfo[] = []
  constraints.forEach((c, i) => {
    if (!c.enabled) return
    list.push({
      constraintId: c.id,
      order: i + 1,
      aId: c.aId,
      bId: c.bId,
      relation: c.relation,
      min: c.min,
      max: c.max,
      relaxedMin: Math.max(0, c.min - epsilon),
      relaxedMax: c.max + epsilon,
    })
  })
  return list
}

/**
 * 统一宽限分析：求最小整数宽限 ε（0 ≤ ε ≤ cap），使全部启用证词与原有观测
 * 同时相容。每条启用证词 [min, max] 统一放宽为 [max(0, min−ε), max+ε]，
 * 观测与停用证词不变。
 *
 * 关键单调性：ε 越大，每条证词的区间越宽（下界不增、上界不减），差分系统
 * 的约束随之单调变弱，因此可满足性关于 ε 单调——一旦某个 ε 可行，更大的
 * ε 必然可行。据此在 [0, cap] 上**二分**最小可行整数 ε，而不是逐分钟枚举：
 * 判定次数为 O(log cap) 次负环检测（每次 O(V·E)）。
 *
 * - 原案卷（ε = 0）相容时直接返回 0；
 * - ε = cap 仍不可满足时返回 solvable = false，并附上 ε = cap 放宽系统中的
 *   一条矛盾环（观测边与约束边同图抽取）供复核；
 * - 成功时给出放宽后的证词区间与事件绝对时间窗（复用 analyze，与主界面
 *   口径一致；无有效观测时 baseISO 为 null，全部事件无法定时）。
 *
 * 本函数为纯计算：不修改约束、观测或任何本地存档。
 */
export function analyzeUniformSlack(
  events: TEvent[],
  constraints: Constraint[],
  observations: TimeObservation[],
  cap: number,
): SlackAnalysis {
  // 调用方保证非负整数；防御性归一（非法输入按 0 处理）
  const M = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 0
  let probes = 0
  const probe = (epsilon: number) => {
    probes++
    return analyze(events, relaxConstraints(constraints, epsilon), observations)
  }

  // 原案卷（ε = 0）相容：最小宽限即 0
  const at0 = probe(0)
  if (at0.satisfiable) {
    return {
      cap: M,
      solvable: true,
      epsilon: 0,
      relaxed: relaxedList(constraints, 0),
      windows: at0.windows,
      baseISO: at0.baseISO,
      cycleAtCap: null,
      probes,
    }
  }

  // ε = M 仍不可满足：上限内无解，取 ε = M 放宽系统中的一条矛盾链供复核
  const atCap = M === 0 ? at0 : probe(M)
  if (!atCap.satisfiable) {
    return {
      cap: M,
      solvable: false,
      epsilon: null,
      relaxed: [],
      windows: new Map(),
      baseISO: atCap.baseISO,
      cycleAtCap: atCap.cycle ?? null,
      probes,
    }
  }

  // 单调性二分：不变式 lo 不可行（已知 0 不可行）、hi 可行（已知 M 可行）
  let lo = 0
  let hi = M
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (probe(mid).satisfiable) hi = mid
    else lo = mid
  }
  const epsilon = hi

  // 用最小可行 ε 的放宽系统产出展示数据（区间清单 + 事件时间窗）
  const solved = analyze(events, relaxConstraints(constraints, epsilon), observations)
  return {
    cap: M,
    solvable: true,
    epsilon,
    relaxed: relaxedList(constraints, epsilon),
    windows: solved.windows,
    baseISO: solved.baseISO,
    cycleAtCap: null,
    probes,
  }
}
