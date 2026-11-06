import { useId } from 'react'

// 图标：iOS 风格的圆角方块（深色渐变 + 顶部高光），里面是一条向上的净值曲线，末端一个薄荷绿的点。
export function Mark({ size = 36 }: { size?: number }) {
  const id = useId()
  return <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden style={{ filter: 'drop-shadow(0 3px 8px rgba(0,0,0,.45))' }}>
    <defs>
      <linearGradient id={id + 'b'} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#3a4254" /><stop offset="1" stopColor="#0b0e16" /></linearGradient>
      <linearGradient id={id + 'g'} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".28" /><stop offset=".5" stopColor="#fff" stopOpacity="0" /></linearGradient>
    </defs>
    <rect width="64" height="64" rx="14.4" fill={`url(#${id}b)`} />
    <rect width="64" height="64" rx="14.4" fill={`url(#${id}g)`} />
    <rect x=".5" y=".5" width="63" height="63" rx="13.9" stroke="#fff" strokeOpacity=".22" />
    <path d="M15 43L26 32L34 38L47 21" stroke="#fff" strokeWidth="4.4" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="47" cy="21" r="5.2" fill="var(--mint)" style={{ filter: 'drop-shadow(0 0 6px var(--mint-a5))' }} />
  </svg>
}

// 字标：系统字体（苹果上就是 SF Pro）粗体 + 收紧字距；withMark 时左边带圆角方块图标。
export default function Wordmark({ className, withMark = false }: { className?: string; withMark?: boolean }) {
  return <span className={'wordmark ' + (className ?? '')} role="img" aria-label="Fortuna">
    {withMark && <Mark size={30} />}<span aria-hidden>Fortuna</span>
  </span>
}
