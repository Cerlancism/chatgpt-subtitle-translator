export function SubtitleCard({ children, label, }) {
  return (
    <>
      <div className=''>
        <h2 className="text-lg font-medium">{label}</h2>
        <div className="rounded-lg pl-8 pr-3 py-3 mb-2 shadow-md border">
          <div className='ml-4 rounded-lg shadow-inner border bg-card text-card-foreground min-h-80 '>
              {children}
            </div>
        </div>
      </div>
    </>
  )
}
