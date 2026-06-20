interface Props {
  src: string | null | undefined
  name: string
  size?: number
}

export function TeamCrest({ src, name, size = 28 }: Props) {
  if (src) {
    return (
      <img
        src={src}
        alt={name}
        width={size}
        height={size}
        className="object-contain"
        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
      />
    )
  }
  return (
    <div
      className="bg-surface-3 rounded-full flex items-center justify-center text-muted font-bold"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {name.substring(0, 2).toUpperCase()}
    </div>
  )
}
