import type {
  Constraint,
  SlackAnalysis,
  SlackRelaxedConstraint,
  TimeObservation,
  TEvent,
} from '../types'
import { analyze, buildSystem, findNegativeCycle } from './graph'

/**
 * 统一宽限 ε 下把全部启用证词放宽：每条启用证词 [min, max] 变为
 * [max(0, min−ε), max+ε]，早于/晚于方向不变；停用证词与观测不变。
 * 返回新数组，不修改入参（分析只读）。
 */
export function relaxConstraints(constraints: Constraint[], eps: number): Constraint[] {
  if (eps === 0) return constraints
  return constraints.map((c) =>
    c.enabled ? { ...c, min: Math.max(0, c.min - eps), max: c.max + eps } : c,
  )
}

/**
 * 统一宽限分析：求使全部启用证词与原有观测同时相容的最小整数宽限 ε（0 ≤ ε ≤ cap）。
 *
 * 单调性：ε 增大时每条启用证词的放宽区间只会变宽（下界 max(0, min−ε) 不增、
 * 上界 max+ε 不减），因此「系统在宽限 ε 下可满足」关于 ε 单调不减——若 ε 可行，
 * 则任意 ε′ ≥ ε 也可行。于是在 [0, cap] 上二分最小可行整数 ε，
 * 每次可行性判定都是对放宽后的统一差分图（放宽证词边 + 原观测边 + 时间原点）
 * 做一次负环检测，共 O(log cap) 次 Bellman-Ford，不逐分钟枚举。
 *
 * 原案卷（ε = 0）已可满足时直接返回 0；cap 处仍不可满足时返回 epsilon = null
 * 并附上 ε = cap 放宽系统中的一条矛盾链。成功时给出放宽后区间与各事件时间窗
 * （无有效观测时 baseISO 为 null，事件按「无法定时」展示）。
 *
 * 纯计算：不修改案卷数据，也不写入任何本地存储。
 *
 * 前置条件：cap 为非负整数（面板已校验）。
 */
export function computeUniformSlack(
  events: TEvent[],
  constraints: Constraint[],
  observations: TimeObservation[],
  cap: number,
): SlackAnalysis {
  /** 宽限 eps 下系统是否可满足（复用统一差分图求解器） */
  const satisfiableAt = (eps: number): boolean => {
    const sys = buildSystem(events, relaxConstraints(constraints, eps), observations)
    return findNegativeCycle(sys.n + 1, sys.edges) === null
  }

  /** 全部启用证词在宽限 eps 下的放宽区间（按约束录入顺序） */
  const relaxedList = (eps: number): SlackRelaxedConstraint[] =>
    constraints
      .filter((c) => c.enabled)
      .map((c) => ({
        constraintId: c.id,
        originalMin: c.min,
        originalMax: c.max,
        min: Math.max(0, c.min - eps),
        max: c.max + eps,
      }))

  /** 成功结果：放宽后的区间、时间窗与基准 */
  const success = (eps: number): SlackAnalysis => {
    const relaxedConstraints = relaxConstraints(constraints, eps)
    const r = analyze(events, relaxedConstraints, observations)
    return {
      cap,
      epsilon: eps,
      originalSatisfiable: eps === 0,
      relaxed: relaxedList(eps),
      windows: r.windows,
      baseISO: r.baseISO,
      cycle: null,
      relaxedConstraints,
    }
  }

  // 原案卷相容：最小宽限即 0
  if (satisfiableAt(0)) return success(0)

  // 上限处仍矛盾：无解，展示 ε = cap 时的矛盾链
  if (!satisfiableAt(cap)) {
    const relaxedConstraints = relaxConstraints(constraints, cap)
    const r = analyze(events, relaxedConstraints, observations)
    return {
      cap,
      epsilon: null,
      originalSatisfiable: false,
      relaxed: relaxedList(cap),
      windows: r.windows,
      baseISO: r.baseISO,
      cycle: r.cycle ?? null,
      relaxedConstraints,
    }
  }

  // 单调性二分：不变式 lo 不可行、hi 可行
  let lo = 0
  let hi = cap
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (satisfiableAt(mid)) hi = mid
    else lo = mid
  }
  return success(hi)
}
