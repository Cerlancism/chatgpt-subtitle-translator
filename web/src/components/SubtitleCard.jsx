export function SubtitleCard({ children, label, }) {
  return (
    <>
      <div className=''>
        <h2 className="text-lg font-medium">{label}</h2>
        <div className="rounded-lg pl-8 mb-2 border">
            <div className='ml-4 rounded-lg border-l bg-card text-card-foreground shadow-sm min-h-80 '>
              {children}
            </div>
        </div>
      </div>
    </>
  )
}
