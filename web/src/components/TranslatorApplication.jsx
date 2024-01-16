"use client"
import React, { useEffect, useRef, useState } from 'react'
import { Accordion, AccordionItem, Button, Input } from "@nextui-org/react";

import { EyeSlashFilledIcon } from './EyeSlashFilledIcon';
import { EyeFilledIcon } from './EyeFilledIcon';

import { FileUploadButton } from '@/components/FileUploadButton';
import { SubtitleCard } from '@/components/SubtitleCard';
import { sampleSrt } from '@/data/sample';

import { Translator } from "chatgpt-subtitle-translator"
import { parser } from 'chatgpt-subtitle-translator/src/subtitle.mjs';
import { createOpenAIClient } from 'chatgpt-subtitle-translator/src/openai.mjs'
import { downloadString } from '@/utils/download';

const OPENAI_API_KEY = "OPENAI_API_KEY"

export function TranslatorApplication() {
  const [isVisible, setIsConfigurationVisible] = useState(false);
  const [APIvalue, setAPIValue] = useState("");
  const [fromLanguage, setFromLanguage] = useState("")
  const [toLanguage, setToLanguage] = useState("English")
  const [srtInputText, setSrtInputText] = useState(sampleSrt)
  const [srtOutputText, setSrtOutputText] = useState(sampleSrt)
  const [inputs, setInputs] = useState(parser.fromSrt(sampleSrt).map(x => x.text))
  const [outputs, setOutput] = useState([])
  const [streamOutput, setStreamOutput] = useState("")
  const [translatorRunningState, setTranslatorRunningState] = useState(false)

  /** @type {React.MutableRefObject<Translator>} */
  const translatorRef = useRef(null)

  const translatorRunningRef = useRef(false)

  const toggleConfigurationVisibility = () => setIsConfigurationVisible(!isVisible);

  function setAPIKey(value) {
    localStorage.setItem(OPENAI_API_KEY, value)
    setAPIValue(value)
  }

  async function generate(e) {
    e.preventDefault()
    setTranslatorRunningState(true)
    console.log("[User Interface]", "Begin Generation")
    translatorRunningRef.current = true
    setOutput([])
    let currentStream = ""
    const outputWorkingProgress = parser.fromSrt(srtInputText)
    const currentOutputs = []
    const openai = createOpenAIClient(APIvalue, true)
    translatorRef.current = new Translator({ from: fromLanguage, to: toLanguage }, {
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
    })
    try {
      for await (const output of translatorRef.current.translateLines(inputs)) {
        if (!translatorRunningRef.current) {
          console.error("[User Interface]", "Aborted")
          setStreamOutput("")
          break
        }
        currentOutputs.push(output.finalTransform)
        const srtEntry = outputWorkingProgress[output.index - 1]
        srtEntry.text = output.finalTransform
        setOutput([...currentOutputs])
      }
      console.log({ sourceInputWorkingCopy: outputWorkingProgress })
      setSrtOutputText(parser.toSrt(outputWorkingProgress))
    } catch (error) {
      console.error(error)
      alert(error?.message ?? error)
    }
    translatorRunningRef.current = false
    translatorRef.current = null
    setTranslatorRunningState(false)
  }

  async function stopGeneration() {
    console.error("[User Interface]", "Aborting")
    if (translatorRef.current) {
      translatorRunningRef.current = false
      translatorRef.current.abort()
    }
  }

  useEffect(() => {
    setAPIValue(localStorage.getItem(OPENAI_API_KEY) ?? "")
  }, [])

  return (
    <>
      <div className='w-full'>
        <form onSubmit={(e) => generate(e)}>
          <div className='p-4 flex flex-wrap justify-between w-full gap-4'>
            <Accordion className='border-1 md:w-9/12' variant="bordered" defaultSelectedKeys="all">
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
                      <button className="focus:outline-none" type="button" onClick={toggleConfigurationVisibility}>
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
                      label="From Language"
                      placeholder="Auto"
                      value={fromLanguage}
                      onValueChange={setFromLanguage}
                    />
                    <Input
                      className='w-full md:w-6/12'
                      size='sm'
                      type="text"
                      label="To Language"
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
                  setSrtInputText(text)
                  setInputs(parsed.map(x => x.text))
                } catch (error) {
                  alert(error.message ?? error)
                }
              }} />
              {!translatorRunningState && (
                <Button type='submit' color="primary" isDisabled={!APIvalue || translatorRunningState}>
                  Start
                </Button>
              )}

              {translatorRunningState && (
                <Button color="danger" onClick={() => stopGeneration()}>
                  Stop
                </Button>
              )}

              <Button color="primary" onClick={() => {
                // console.log(srtOutputText)
                downloadString(srtOutputText, "text/plain", "export.srt")
              }}>
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
      </div>
    </>
  )
}
