import { TranslatorApplication } from '@/components/TranslatorApplication';
import { basePath } from '@/../next.config';
import { Link } from '@nextui-org/react';

export default function Home() {
  return (
    <>
      <main className='min-h-screen flex flex-col justify-between'>
        <TranslatorApplication />
        <footer className="flex w-full mb-4">
          <div className='mx-auto'>
            <b className='w-full'>ChatGPT Subtitle Translator</b>
            <div className='flex flex-wrap items-center justify-center'>
              <div className='w-40 sm:w-auto text-center'>
                <Link isExternal className='mr-2 text-blue-500' href="https://github.com/Cerlancism">
                  @Cerlancism
                </Link>
              </div>
              <a href="https://github.com/Cerlancism/chatgpt-subtitle-translator" target="_blank" rel="noopener noreferrer" className="flex items-center justify-center">
                <img className='w-8 h-8 mx-auto' src={`${basePath}/github-mark.svg`} alt="GitHub" />
              </a>
            </div>
          </div>
        </footer>
      </main>

    </>
  )
}
