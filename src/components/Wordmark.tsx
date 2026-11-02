// Fortuna 字标：按图形线条画的，不依赖任何字体文件。O 就是图标：圆环里一条向上的净值曲线，末端一个薄荷绿的点。
const LETTERS = [
  { x: 0, d: 'M3 2H16M3 2V26M3 14H14' },
  { x: 49, d: 'M3 26V2H12a6.5 6.5 0 0 1 0 13H3M11 15L18 26' },
  { x: 71, d: 'M1 2H19M10 2V26' },
  { x: 94, d: 'M3 2V19a7 7 0 0 0 14 0V2' },
  { x: 114, d: 'M3 26V2L17 26V2' },
  { x: 137, d: 'M1 26L10 2L19 26M4 18H16' },
]

export default function Wordmark({ className }: { className?: string }) {
  return <svg className={className} viewBox="-3 -3 164 34" fill="none" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="Fortuna">
    <g stroke="currentColor">{LETTERS.map(letter => <path key={letter.x} transform={`translate(${letter.x} 0)`} d={letter.d} />)}</g>
    <g transform="translate(22 0)"><circle cx="12" cy="14" r="12" stroke="currentColor" /><path d="M5.1 19.1L9.2 14.5L12.9 17.2L18.5 9.9" stroke="currentColor" /><circle cx="18.5" cy="9.9" r="2.3" fill="var(--mint)" stroke="none" style={{ filter: 'drop-shadow(0 0 4px var(--mint-a4))' }} /></g>
  
  </svg>
}

// 图标：一个圆环里一条向上的净值曲线，末端是一个薄荷绿的点。
export function Mark({ size = 36 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 32 32" fill="none" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="16" cy="16" r="13" stroke="var(--text-1)" opacity=".85" />
    <path d="M8.5 21.5L13 16.5L17 19.5L23 11.5" stroke="var(--text-1)" />
    <circle cx="23" cy="11.5" r="2.4" fill="var(--mint)" stroke="none" style={{ filter: 'drop-shadow(0 0 4px var(--mint-a4))' }} />
  </svg>
}
