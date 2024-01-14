"use client"
import { useEffect, useState } from 'react'
import { Accordion, AccordionItem, Button, Input, input } from "@nextui-org/react";

import { EyeSlashFilledIcon } from './EyeSlashFilledIcon';
import { EyeFilledIcon } from './EyeFilledIcon';

import { FileUploadButton } from '@/components/FileUploadButton';
import { SubtitleCard } from '@/components/SubtitleCard';
import { sampleSrt } from '@/data/sample';

import { Translator } from "chatgpt-subtitle-translator"
import { parser } from 'chatgpt-subtitle-translator/src/subtitle.mjs';
import { createOpenAIClient } from 'chatgpt-subtitle-translator/src/openai.mjs'

const OPENAI_API_KEY = "OPENAI_API_KEY"

const sampleSrtParsed = parser.fromSrt(sampleSrt)

export function TranslatorApplication() {
  const [inputs, setInputs] = useState(sampleSrtParsed.map(x => x.text))
  const [outputs, setOutput] = useState([])
  const [isVisible, setIsVisible] = useState(false);
  const toggleVisibility = () => setIsVisible(!isVisible);
  const [APIvalue, setAPIValue] = useState("");
  const [fromLanguage, setFromLanguage] = useState("")
  const [toLanguage, setToLanguage] = useState("English")
  const [streamOutput, setStreamOutput] = useState("")

  function setAPIKey(value) {
    localStorage.setItem(OPENAI_API_KEY, value)
    setAPIValue(value)
  }

  async function generate(e) {
    e.preventDefault()
    setOutput([])
    let currentStream = ""
    const sourceInputWorkingCopy = inputs.slice()
    const currentOutputs = []
    const openai = createOpenAIClient(APIvalue, true)
    const translator = new Translator({ to: "English" }, {
      openai,
      onStreamChunk: (data) => {
        currentStream += data
        setStreamOutput(currentStream)
      },
      onStreamEnd: () => {
        currentStream = ""
        setStreamOutput("")
      }
    }, {
      createChatCompletionRequest: {
        temperature: 0,
        stream: true
      },
      batchSizes: [5,10]
    })

    try {
      for await (const output of translator.translateLines(inputs)) {
        currentOutputs.push(output.finalTransform)
        setOutput([...currentOutputs])
      }

      console.log({sourceInputWorkingCopy})
    } catch (error) {
      console.error(error)
      alert(error?.message ?? error)
    }

  }

  useEffect(() => {
    setAPIValue(localStorage.getItem(OPENAI_API_KEY) ?? "")
  }, [])

  return (
    <>
      <main className='light'>
        <form onSubmit={(e) => generate(e)}>
          <div className='p-4 flex flex-wrap justify-between w-full gap-4'>
            <Accordion className='border-1 md:w-9/12' variant="bordered" defaultExpandedKeys={["1"]}>
              <AccordionItem key="1" isCompact aria-label="Configuration" title="Configuration">
                <div className='flex flex-wrap justify-between w-full gap-4 mb-2 p-4'>
                  <Input
                    className="w-full"
                    size='sm'
                    autoFocus={true}
                    value={APIvalue}
                    onValueChange={(value) => setAPIKey(value)}
                    isRequired
                    autoComplete='off'
                    label="OpenAI API Key"
                    variant="flat"
                    description="API Key is stored locally in browser"
                    endContent={
                      <button className="focus:outline-none" type="button" onClick={toggleVisibility}>
                        {isVisible ? (
                          <EyeSlashFilledIcon className="text-2xl text-default-400 pointer-events-none" />
                        ) : (
                          <EyeFilledIcon className="text-2xl text-default-400 pointer-events-none" />
                        )}
                      </button>
                    }
                    type={isVisible ? "text" : "password"}
                  />
                  <div className='flex w-full gap-4'>
                    <Input
                      className='w-full md:w-6/12'
                      size='sm'
                      type="text"
                      label="From"
                      placeholder="From Language"
                      value={fromLanguage}
                      onValueChange={setFromLanguage}
                    />
                    <Input
                      className='w-full md:w-6/12'
                      size='sm'
                      type="text"
                      label="To"
                      value={toLanguage}
                      onValueChange={setToLanguage}
                    />
                  </div>

                </div>
              </AccordionItem>
            </Accordion>

            <div className='flex gap-4 mt-auto'>
              <FileUploadButton label={"Load SRT"} onFileSelect={async (file) => {
                // console.log("File", file);
                try {
                  const text = await file.text()
                  const parsed = parser.fromSrt(text)
                  setInputs(parsed.map(x => x.text))
                } catch (error) {
                  alert(error.message ?? error)
                }
              }} />
              <Button type='submit' color="primary" isDisabled={!APIvalue}>
                Start
              </Button>

              <Button color="primary">
                Export SRT
              </Button>
            </div>
          </div>
        </form>
        <div className="lg:flex lg:gap-4 px-4">
          <div className="lg:w-1/2 py-4">
            <SubtitleCard text={"Input"}>
              <ol className="py-2 list-decimal">
                {inputs.map((line, i) => {
                  return (
                    <li key={i} className=''>
                      <div className='ml-4 truncate'>
                        {line}
                      </div>
                    </li>
                  )
                })}
              </ol>
            </SubtitleCard>
          </div>

          <div className="lg:w-1/2 py-4">
            <SubtitleCard text={"Output"}>
              <ol className="py-2 list-decimal">
                {outputs.map((line, i) => {
                  return (
                    <li key={i} className=''>
                      <div className='ml-4 truncate'>
                        {line}
                      </div>
                    </li>
                  )
                })}
                <pre className='px-2'>
                  {streamOutput}
                </pre>
              </ol>

            </SubtitleCard>
          </div>
        </div>
      </main>
    </>
  )
}
