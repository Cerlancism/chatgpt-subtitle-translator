export function SubtitleCard({ children, text }) {
  return (
    <>
      <div className='rounded-lg border bg-card shadow-sm'>
        <div className='p-8'>
          <h2 className="text-lg font-medium">{text}</h2>
          <div className="rounded-lg pl-8 border">
            <div className='ml-4 rounded-lg border-l bg-card text-card-foreground shadow-sm min-h-96 '>
              {children}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
