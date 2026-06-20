interface Props {
  url: string | null | undefined
  username: string
  size?: number
}

export function Avatar({ url, username, size = 32 }: Props) {
  const initials = username?.substring(0, 2).toUpperCase() ?? '??'
  if (url) {
    return (
      <img
        src={url}
        alt={username}
        style={{ width: size, height: size }}
        className="rounded-full object-cover"
      />
    )
  }
  // Deterministic color from username
  const colors = ['#00FF87', '#FF3B3B', '#FFB800', '#3B9EFF', '#FF6B3B', '#B33BFF']
  const idx = username?.charCodeAt(0) % colors.length || 0
  return (
    <div
      className="rounded-full flex items-center justify-center font-semibold"
      style={{ width: size, height: size, background: colors[idx] + '22', color: colors[idx], fontSize: size * 0.38 }}
    >
      {initials}
    </div>
  )
}
