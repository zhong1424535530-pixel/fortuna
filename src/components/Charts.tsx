import { currentLang, t } from '../i18n'
import { themeColor } from '../theme'
import { usdCny } from '../data/forex'
import { isReal } from '../data/live'
import { useEffect, useId, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { Decimal } from 'decimal.js'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, AriaComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsCoreOption } from 'echarts/core'
import { Avatar, HiddenChart, Unavailable } from './ui'
import { allocations, assetValueCents, formatMoney, hasLocalValuation, historyFor, summarizeContracts } from '../data/portfolio'
import type { ContractPosition, Currency, HistoryPoint, Holding, Period } from '../data/portfolio'
import { overviewHoldings } from '../data/overview'
import type { ReturnDay } from '../data/returns-analysis'
import { groupWeeks, isWeekly, returnDaySlots } from '../data/returns-analysis'
import type { ReturnCurves } from '../data/returns-curve'

echarts.use([BarChart, LineChart, PieChart, GridComponent, TooltipComponent, AriaComponent, CanvasRenderer])

// 折线图共用：金额刻度用短数字（≥1万写“万”）、只画 3 条虚线、时间刻度只留首/中/末。
function compactAmount(value: number) {
  const abs = Math.abs(value)
  if (abs >= 10000) return currentLang() === 'en' ? Number((value / 1000).toFixed(0)) + 'k' : Number((value / 10000).toFixed(1)) + '万'
  return String(Number(value.toFixed(abs >= 100 ? 0 : 2)))
}
const lineGrid = { left: 0, right: 8, top: 14, bottom: 0, containLabel: true }
const axisLabelStyle = (extra: object = {}) => ({ color: themeColor('text-4'), fontSize: 12, ...extra })
// 苹果式图表：系统字体、玻璃提示框、发光折线、渐变面积；首次出现 0.9 秒缓出，数据更新只做短过渡。
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif'
const motionOptions = { animation: true, animationDuration: 900, animationEasing: 'cubicOut', animationDurationUpdate: 300 } as const
const tip = () => ({ backgroundColor: 'rgba(40,40,46,.88)', borderColor: 'rgba(255,255,255,.2)', borderWidth: 1, borderRadius: 14, padding: [10, 14], shadowBlur: 30, shadowColor: 'rgba(0,0,0,.45)', textStyle: { color: themeColor('text-1'), fontSize: 13, fontFamily: FONT } })
const tint = (alpha: number, name = 'mint') => { const hex = themeColor(name); return `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${alpha})` }
const glowArea = () => ({ color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: tint(.3) }, { offset: 1, color: tint(0) }]) })
const amountAxis = (formatter: (value: number) => string = compactAmount, extra: object = {}) => ({ type: 'value', splitNumber: 2, axisLabel: axisLabelStyle({ margin: 8, formatter }), splitLine: { lineStyle: { color: themeColor('fill-2'), type: [3, 5] } }, ...extra })
const edgeLabels = (count: number) => count <= 7 ? 0 : (index: number) => index === 0 || index === count - 1 || index === Math.floor((count - 1) / 2)

function Chart({ option, label, className = '', onSelect }: { option: EChartsCoreOption; label: string; className?: string; onSelect?: (id: string) => void }) {
  const container = useRef<HTMLDivElement>(null)
  const instance = useRef<ReturnType<typeof echarts.init> | null>(null)
  const selectHandler = useRef(onSelect)
  useEffect(() => { selectHandler.current = onSelect }, [onSelect])
  useEffect(() => {
    if (!container.current) return
    const element = container.current
    const chart = echarts.init(element, undefined, { renderer: 'canvas' })
    instance.current = chart
    chart.on('click', event => {
      const id = (event.data as { id?: unknown } | undefined)?.id
      if (typeof id === 'string') selectHandler.current?.(id)
    })
    let width = element.clientWidth, height = element.clientHeight
    const observer = new ResizeObserver(() => {
      if (width === element.clientWidth && height === element.clientHeight) return
      width = element.clientWidth; height = element.clientHeight
      chart.resize()
    })
    observer.observe(element)
    return () => { observer.disconnect(); chart.dispose(); instance.current = null }
  }, [])
  useEffect(() => {
    // 保留图表及悬停位置，只替换数据与坐标轴，避免页面更新清掉提示框。
    instance.current?.setOption(option, { replaceMerge: ['series', 'xAxis', 'yAxis'] })
  }, [option])
  return <div ref={container} role="img" aria-label={label} className={`chart ${className}`} />
}

export function IncomeChart({ days, unit, hidden, daily, label, dateRange }: { days: ReturnDay[]; unit: string; hidden: boolean; daily: boolean; label: string; dateRange?: { start: number; end: number } }) {
  const slots = daily && dateRange ? returnDaySlots(days, dateRange.start, dateRange.end) : days
  const plottedDays = daily && isWeekly(slots) ? groupWeeks(slots) : slots
  const values = plottedDays.map(day => { const value = daily ? day.amount : day.cumulative; return value === null ? null : Number(value) })
  // 同一年内只写月/日：完整日期太长，最后一个标签放不下时会被隐藏，却仍给它留出右边的空白。
  const shortDates = plottedDays.every(day => /^\d{4}-\d{2}-\d{2}$/.test(day.label)) && (daily || new Set(plottedDays.map(day => day.label.slice(0, 4))).size === 1)
  const drawable = values.every(value => value === null || Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER)
  // 页面每次刷新都会生成新数组；按内容判断，数据没变就不重画图表。
  const dataKey = plottedDays.map(day => day.label).join() + '|' + values.join()
  const option = useMemo<EChartsCoreOption>(() => ({
    ...motionOptions,
    textStyle: { fontFamily: FONT },
    grid: lineGrid,
    tooltip: { renderMode: 'richText', trigger: 'axis', confine: true, ...tip(), valueFormatter: (value: unknown) => value === null || value === undefined || value === '-' ? t('无已记录平仓') : `${Number(value).toFixed(2)} ${unit}` },
    xAxis: { type: 'category', boundaryGap: daily, data: plottedDays.map(day => day.label), axisLine: { lineStyle: { color: themeColor('line-solid') } }, axisTick: { show: false }, axisLabel: axisLabelStyle({ hideOverlap: true, formatter: (value: string) => shortDates ? value.slice(5).replace('-', '/') : value, interval: edgeLabels(plottedDays.length) }) },
    yAxis: amountAxis(compactAmount, { scale: !daily }),
    series: [{ type: daily ? 'bar' : 'line', name: label, data: values.map(value => ({ value, itemStyle: { color: value !== null && value < 0 ? themeColor('down') : themeColor('mint'), borderRadius: value !== null && value < 0 ? [3, 3, 8, 8] : [8, 8, 3, 3] } })), barMaxWidth: 26, showSymbol: days.length < 3, symbolSize: 7, smooth: false, lineStyle: { color: themeColor('mint'), width: 3, cap: 'round', join: 'round', shadowBlur: 14, shadowColor: tint(.35) }, areaStyle: daily ? undefined : glowArea() }],
  }), [dataKey, unit, daily, label, shortDates])
  if (hidden) return <HiddenChart className="returns-income-chart" />
  if (!days.length || !drawable) return <div className="chart-empty returns-income-chart" role="status">{drawable ? t('所选范围暂无可展示的收支记录') : t('金额超出图表显示范围，请查看明细')}</div>
  return <Chart option={option} label={`${t(label)}, ${t('单位')} ${unit}, ${daily && dateRange ? t('按完整日期排列，无已记录平仓的日期留空') : t('仅展示有记录的日期')}`} className="returns-income-chart" />
}

export function ContractRatioChart({ parts, label, hidden, children }: { parts: { name: string; value: number; color: string }[]; label: string; hidden: boolean; children: ReactNode }) {
  const tooltipId = useId()
  const present = parts.filter(part => part.value > 0)
  const total = present.reduce((sum, part) => sum + part.value, 0)
  const partsKey = JSON.stringify(parts)
  const option = useMemo<EChartsCoreOption>(() => ({
    ...motionOptions,
    tooltip: { show: false },
    series: [{
      type: 'pie', radius: ['70%', '96%'], center: ['50%', '50%'], startAngle: 90, padAngle: present.length > 1 ? 3 : 0, itemStyle: { borderRadius: 6 },
      label: { show: false }, labelLine: { show: false }, emphasis: { disabled: true }, stillShowZeroSum: false,
      data: present.length ? present.map(part => ({ name: part.name, value: part.value, itemStyle: { color: part.color } })) : [{ name: t('暂无已核对平仓'), value: 1, itemStyle: { color: themeColor('line-solid') } }],
    }],
  }), [partsKey])
  if (hidden) return <span className="returns-summary-hidden" aria-label={t('数据已隐藏')}>••••</span>
  return <div className="returns-summary-ring" tabIndex={present.length ? 0 : undefined} aria-describedby={present.length ? tooltipId : undefined}>
    <Chart option={option} label={label} className="returns-summary-ring-canvas" />
    <div className="returns-summary-ring-center" aria-hidden>{children}</div>
    {present.length > 0 && <div id={tooltipId} role="tooltip" className="returns-ring-tooltip">{present.map(part => <div key={part.name}><span><i style={{ backgroundColor: part.color }} aria-hidden />{part.name}</span><span>{part.value} {t('笔 ·')} {(part.value / total * 100).toFixed(1)}%</span></div>)}</div>}
  </div>
}

export function ReturnsComparisonChart({ curves, unit, hidden }: { curves: ReturnCurves; unit: string; hidden: boolean }) {
  const series = [{ name: t('本期'), color: themeColor('mint'), curve: curves.current }, ...(curves.previous ? [{ name: t('上期'), color: '#8eb9e5', curve: curves.previous }] : [])]
  const points = series.flatMap(item => item.curve.points), known = points.filter(point => point.amount !== null)
  const drawable = known.every(point => Number.isFinite(Number(point.amount)) && Math.abs(Number(point.amount)) <= Number.MAX_SAFE_INTEGER)
  const money = (amount: string) => {
    const value = new Decimal(amount), rounded = value.toDecimalPlaces(2)
    if (!value.isZero() && rounded.isZero()) return (value.lt(0) ? '-' : '+') + '<0.01'
    return (rounded.gt(0) ? '+' : '') + rounded.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  }
  const days = Math.max(...series.map(item => item.curve.days))
  const option: EChartsCoreOption = {
    ...motionOptions,
    textStyle: { fontFamily: FONT },
    grid: { ...lineGrid, top: 28 },
    tooltip: {
      renderMode: 'richText', trigger: 'axis', confine: true, ...tip(),
      formatter: (params: unknown) => {
        const items = (Array.isArray(params) ? params : [params]) as { axisValue: number }[]
        const day = Math.round(Number(items[0]?.axisValue))
        return [t('第 {n} 天', { n: day }), ...series.map(item => {
          const point = item.curve.points.find(point => point.day === day)
          const date = point ? new Date(point.time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : ''
          return `${item.name}${date ? ' ' + date : ''}: ${point?.amount != null ? money(point.amount) + ' ' + unit : t('暂无可核对记录')}`
        })].join('\n')
      },
    },
    xAxis: { type: 'value', min: days === 1 ? 0 : 1, max: days, minInterval: 1, splitNumber: 2, axisPointer: { snap: true }, axisLine: { lineStyle: { color: themeColor('line-solid') } }, axisTick: { show: false }, splitLine: { show: false }, axisLabel: axisLabelStyle({ hideOverlap: true, formatter: (value: number) => value <= 0 ? '' : value === days ? t('{n}天', { n: value }) : String(value) }) },
    yAxis: amountAxis(),
    series: series.map((item, index) => {
      const lastIndex = item.curve.points.reduce((found, point, at) => point.amount !== null ? at : found, -1), knownCount = item.curve.points.filter(point => point.amount !== null).length
      return {
      type: 'line', name: item.name,
      data: item.curve.points.map((point, at) => { const value = [point.day, point.amount === null ? null : Number(point.amount)]; return at === lastIndex ? { value, label: { show: true, position: 'top', distance: 10, color: item.color, fontSize: 12, formatter: () => money(point.amount!) } } : value }),
      connectNulls: false, smooth: 0.18, smoothMonotone: 'x', showSymbol: true, symbol: 'circle', symbolSize: (_value: unknown, params: { dataIndex: number }) => knownCount < 3 ? 4 : params.dataIndex === lastIndex ? 5 : 0,
      lineStyle: { color: item.color, width: index ? 2 : 3, type: index ? 'dashed' : 'solid', cap: 'round', shadowBlur: index ? 0 : 14, shadowColor: tint(.35) }, itemStyle: { color: item.color },
      areaStyle: index ? undefined : glowArea(),
    }}),
  }
  return <div className="returns-period-curve">
    <div className="returns-period-legend">{series.map(item => <span key={item.name}>{item.name}</span>)}<small>{unit}</small></div>
    {hidden ? <HiddenChart className="returns-period-chart" /> : !known.length || !drawable ? <div className="chart-empty returns-period-chart" role="status">{drawable ? t('暂无可核对的逐日净收益') : t('金额超出图表显示范围')}</div> : <Chart option={option} label={`${t('两期累计净收益')}, ${t('单位')} ${unit}, ${t('按周期第几天对齐，缺记录处断开')}`} className="returns-period-chart" />}
  </div>
}

export function ContractExposureChart({ items, currency, hidden }: { items: ContractPosition[]; currency: Currency; hidden: boolean }) {
  const option = useMemo<EChartsCoreOption>(() => {
    const summary = summarizeContracts(items)
    return {
      ...motionOptions,
      textStyle: { fontFamily: FONT },
      grid: { left: 42, right: 14, top: 14, bottom: 28 },
      tooltip: { renderMode: 'richText', trigger: 'item', confine: true, ...tip(), valueFormatter: (value: unknown) => formatMoney(Number(value), currency) },
      xAxis: { type: 'value', min: 0, splitNumber: 3, axisLabel: { color: themeColor('text-4'), fontSize: 12, hideOverlap: true, formatter: (value: number) => formatMoney(value, currency, false, 0) }, splitLine: { lineStyle: { color: themeColor('fill-2'), type: [3, 5] } } },
      yAxis: { type: 'category', inverse: true, data: [t('做多'), t('做空')], axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: themeColor('text-3'), fontSize: 12 } },
      series: [{ type: 'bar', name: t('合约仓位金额'), barWidth: 12, showBackground: true, backgroundStyle: { color: themeColor('fill-2'), borderRadius: 6 }, data: [{ value: summary.longNotionalCents, itemStyle: { color: themeColor('mint'), borderRadius: 6 } }, { value: summary.shortNotionalCents, itemStyle: { color: themeColor('down'), borderRadius: 6 } }] }],
    }
  }, [items, currency])
  if (hidden) return <HiddenChart className="contract-exposure-chart" />
  return <Chart option={option} label={t('合约做多与做空仓位金额对比，不是实际资产金额')} className="contract-exposure-chart" />
}

export function HistoryChart({ period, currency, hidden, endValue, price = false, pnl = false, compact = false, historyPoints, className }: { period: Period | '全部时间' | '自定义'; currency: Currency; hidden: boolean; endValue?: number; price?: boolean; pnl?: boolean; compact?: boolean; historyPoints?: HistoryPoint[]; className?: string }) {
  const points = useMemo(() => historyPoints ?? ((isReal() || endValue === undefined && hasLocalValuation()) ? [] : historyFor(period === '1天' || period === '7天' || period === '30天' || period === '1年' ? period : '30天', endValue)), [historyPoints, period, endValue, isReal()])
  const multiplier = currency === 'CNY' ? usdCny() : 1
  const option = useMemo<EChartsCoreOption>(() => {
    if (!points.length || multiplier === null) return {}
    const values = points.map(point => point.valueCents / 100 * multiplier)
    const min = Math.min(...values)
    const max = Math.max(...values)
    const range = max - min || Math.max(Math.abs(max) * .01, 1)
    return {
      ...motionOptions,
      textStyle: { fontFamily: FONT },
      grid: compact ? { left: 22, right: 24, top: 8, bottom: 22 } : lineGrid,
      tooltip: {
        renderMode: 'richText', trigger: 'axis', confine: true, ...tip(),
        valueFormatter: (value: unknown) => typeof value === 'number' ? new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).format(value) : '—',
        axisPointer: { type: 'line', lineStyle: { color: 'rgba(255,255,255,.35)', width: 1 } },
      },
      xAxis: {
        type: 'category', boundaryGap: false, data: points.map(point => point.label),
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: axisLabelStyle({ margin: compact ? 9 : 8, hideOverlap: true, interval: edgeLabels(points.length) }),
      },
      yAxis: amountAxis(price ? value => value.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) : compactAmount, { show: !compact, min: Math.floor(min - range * .25), max: Math.ceil(max + range * .2) }),
      series: [{
        type: 'line', name: pnl ? t('浮动盈亏') : price ? t('价格') : t('资产估值'), data: values, smooth: pnl ? false : .35, symbol: 'circle', showSymbol: false, symbolSize: 6,
        lineStyle: { color: themeColor('mint'), width: 3, cap: 'round', join: 'round', shadowBlur: 14, shadowColor: tint(.35) }, itemStyle: { color: themeColor('mint'), borderColor: '#fff', borderWidth: 2 },
        areaStyle: glowArea(),
      }],
    }
  }, [points, currency, price, pnl, compact, multiplier])
  const chartClass = className ?? (compact ? 'hero-trend-chart' : 'history-chart')
  if (hidden) return <HiddenChart className={chartClass} />
  if (multiplier === null) return <div className={`chart-empty ${chartClass}`} ><Unavailable reason={t('缺少有效汇率，暂时无法折算图表金额。')} /></div>
  if (!points.length) return <div className={`chart-empty ${chartClass}`} ><Unavailable reason={t('所选范围尚未保存可用的历史估值记录。')} /></div>
  return <Chart option={option} label={pnl ? `${t(String(period))} ${t('所选合约浮动盈亏走势，按保存的仓位快照汇总')}` : `${t(String(period))} ${compact ? t('净资产') : price ? t('价格') : t('资产估值')} ${t('曲线，按数量乘现价，包含资金进出')}`} className={chartClass} />
}

export function ReturnsPlaceholder({ hidden, rangeLabel, emptyLabel = t('暂无完整收益记录') }: { rangeLabel: string; hidden: boolean; emptyLabel?: string }) {
  if (hidden) return <HiddenChart className="holdings-return-chart" />
  return <div className="chart-empty holdings-return-chart" role="status" aria-label={`${rangeLabel}：${emptyLabel}`}>{emptyLabel}</div>
}

export function MajorHoldingsChart({ currency, hidden, onSelect, onViewAll }: { currency: Currency; hidden: boolean; onSelect: (assets: Holding[]) => void; onViewAll: () => void }) {
  const groups = overviewHoldings().slice(0, 6)
  const otherCents = Math.max(0, assetValueCents - groups.reduce((sum, group) => sum + group.valueCents, 0))
  if (hidden) return <HiddenChart className="holdings-ranking-hidden" />
  if (!groups.length && otherCents === 0) return <div className="chart-empty holdings-ranking-hidden">{t('暂无可展示的持仓')}</div>
  return <div className="holdings-ranking" aria-label={t('所有账户主要资产排行')}>
    {groups.map(group => {
      const asset = group.assets[0]
      const share = assetValueCents > 0 ? group.valueCents / assetValueCents * 100 : 0
      return <button type="button" className="ranking-row" key={group.id} onClick={() => onSelect(group.assets)}>
        <Avatar src={asset.icon} name={asset.symbol} size={28} company={asset.category === '股票'} />
        <span className="ranking-data"><span className="ranking-label"><strong>{asset.symbol}</strong><span className="numeric">{group.missingPrices ? <Unavailable reason={t('此资产部分持仓缺少有效价格，无法显示完整估值。')} /> : formatMoney(group.valueCents, currency)}</span><small className="numeric">{group.missingPrices || assetValueCents <= 0 ? '—' : `${share.toFixed(1)}%`}</small></span><span className="platform-track" aria-hidden><span style={{ width: `${group.missingPrices ? 0 : Math.min(100, share)}%` }} /></span></span>
      </button>
    })}
    {otherCents > 0 && <button type="button" className="ranking-row" onClick={onViewAll}><Avatar name="其他" size={28} /><span className="ranking-data"><span className="ranking-label"><strong>{t('其他')}</strong><span className="numeric">{formatMoney(otherCents, currency)}</span><small className="numeric">{assetValueCents > 0 ? `${(otherCents / assetValueCents * 100).toFixed(1)}%` : '—'}</small></span><span className="platform-track" aria-hidden><span style={{ width: `${assetValueCents > 0 ? Math.min(100, otherCents / assetValueCents * 100) : 0}%` }} /></span></span></button>}
  </div>
}

export function AllocationChart({ currency, hidden, onSelect }: { currency: Currency; hidden: boolean; onSelect: (name: string) => void }) {
  const option = useMemo<EChartsCoreOption>(() => ({
    ...motionOptions,
    tooltip: { renderMode: 'richText', trigger: 'item', confine: true, ...tip(), formatter: (item: { name: string; value: unknown }) => `${t(item.name)}: ${formatMoney(Number(item.value), currency)}` },
    series: [{
      type: 'pie', radius: ['64%', '90%'], center: ['50%', '50%'], startAngle: 90, padAngle: 3, stillShowZeroSum: false,
      label: { show: false, position: 'inside', color: themeColor('on-mint'), fontSize: 13, fontWeight: 500, formatter: (item: { percent?: number }) => `${(item.percent ?? 0).toFixed(1)}%` }, labelLine: { show: false }, emphasis: { scaleSize: 6, itemStyle: { shadowBlur: 20, shadowColor: 'rgba(0,0,0,.4)' } },
      data: allocations.flatMap(item => item.valueCents <= 0 ? [] : [{ name: item.name, value: item.valueCents, itemStyle: { color: item.color, borderRadius: 12 }, label: { show: false } }]),
    }],
  }), [currency, allocations, assetValueCents])
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!container.current || hidden) return
    const chart = echarts.init(container.current)
    chart.setOption(option)
    chart.on('click', event => onSelect(event.name))
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(container.current)
    return () => { observer.disconnect(); chart.dispose() }
  }, [option, hidden, onSelect])
  return hidden ? <HiddenChart className="allocation-canvas" /> : <div className="allocation-wrap"><div ref={container} className="allocation-canvas" role="img" aria-label={t('资产分布图，分类名称和占比见下方列表，点击查看对应持仓')} /><div className="allocation-center" aria-hidden><span>{t('资产类别')}</span><strong>{allocations.filter(item => item.valueCents > 0).length} {t('类')}</strong></div></div>
}
