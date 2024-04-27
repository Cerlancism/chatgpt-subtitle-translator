"use client"
import React, { useEffect, useRef, useState } from 'react'
import { Accordion, AccordionItem, Button, Input, Card, Textarea, Slider, Switch, CardHeader, CardBody, Divider } from "@nextui-org/react";

import { EyeSlashFilledIcon } from './EyeSlashFilledIcon';
import { EyeFilledIcon } from './EyeFilledIcon';

import { FileUploadButton } from '@/components/FileUploadButton';
import { SubtitleCard } from '@/components/SubtitleCard';
import { downloadString } from '@/utils/download';
import { sampleSrt } from '@/data/sample';

import { Translator } from "chatgpt-subtitle-translator"
import { parser } from 'chatgpt-subtitle-translator/src/subtitle.mjs';
import { createOpenAIClient } from 'chatgpt-subtitle-translator/src/openai.mjs'
import { CooldownContext } from 'chatgpt-subtitle-translator/src/cooldown.mjs';

const OPENAI_API_KEY = "OPENAI_API_KEY"
const OPENAI_BASE_URL = "OPENAI_BASE_URL"
const RATE_LIMIT = "RATE_LIMIT"

export function TranslatorApplication() {
  // Translator Configuration
  const [APIvalue, setAPIValue] = useState("")
  const [baseUrlValue, setBaseUrlValue] = useState(undefined)
  const [fromLanguage, setFromLanguage] = useState("")
  const [toLanguage, setToLanguage] = useState("English")
  const [systemInstruction, setSystemInstruction] = useState("")
  const [model, setModel] = useState("gpt-3.5-turbo")
  const [temperature, setTemperature] = useState(0)
  const [useModerator, setUseModerator] = useState(true)
  const [rateLimit, setRateLimit] = useState(60)
  /** @type {React.MutableRefObject<HTMLInputElement>} */
  const configSection = useRef()
  const [isAPIInputVisible, setIsAPIInputVisible] = useState(false)
  const toggleAPIInputVisibility = () => setIsAPIInputVisible(!isAPIInputVisible)

  // Translator State
  const [srtInputText, setSrtInputText] = useState(sampleSrt)
  const [srtOutputText, setSrtOutputText] = useState(sampleSrt)
  const [inputs, setInputs] = useState(parser.fromSrt(sampleSrt).map(x => x.text))
  const [outputs, setOutput] = useState([])
  const [streamOutput, setStreamOutput] = useState("")
  const [translatorRunningState, setTranslatorRunningState] = useState(false)
  /** @type {React.MutableRefObject<Translator>} */
  const translatorRef = useRef(null)
  const translatorRunningRef = useRef(false)

  // Translator Stats
  const [usageInformation, setUsageInformation] = useState(/** @type {typeof Translator.prototype.usage}*/(null))
  const [RPMInfomation, setRPMInformation] = useState(0)

  // Persistent Data Restoration
  useEffect(() => {
    setAPIValue(localStorage.getItem(OPENAI_API_KEY) ?? "")
    setRateLimit(Number(localStorage.getItem(RATE_LIMIT) ?? rateLimit))
    setBaseUrlWithModerator(localStorage.getItem(OPENAI_BASE_URL) ?? undefined)
  }, [])

  function setAPIKey(value) {
    localStorage.setItem(OPENAI_API_KEY, value)
    setAPIValue(value)
  }

  function setBaseUrl(value) {
    if (!value) {
      value = undefined
      localStorage.removeItem(OPENAI_BASE_URL)
    }
    if (value) {
      localStorage.setItem(OPENAI_BASE_URL, value)
    }
    setBaseUrlWithModerator(value)
  }

  function setBaseUrlWithModerator(value)
  {
    if (!baseUrlValue && value && useModerator) {
      setUseModerator(false)
    }
    setBaseUrlValue(value)
  }

  function setRateLimitValue(value) {
    localStorage.setItem(RATE_LIMIT, value)
    setRateLimit(Number(value))
  }

  async function generate(e) {
    e.preventDefault()
    setTranslatorRunningState(true)
    console.log("[User Interface]", "Begin Generation")
    translatorRunningRef.current = true
    setOutput([])
    setUsageInformation(null)
    let currentStream = ""
    const outputWorkingProgress = parser.fromSrt(srtInputText)
    const currentOutputs = []
    console.log("OPENAI_BASE_URL", baseUrlValue)
    const openai = createOpenAIClient(APIvalue, true, baseUrlValue)

    const coolerChatGPTAPI = new CooldownContext(rateLimit, 60000, "ChatGPTAPI")
    const coolerOpenAIModerator = new CooldownContext(rateLimit, 60000, "OpenAIModerator")

    translatorRef.current = new Translator({ from: fromLanguage, to: toLanguage }, {
      openai,
      cooler: coolerChatGPTAPI,
      onStreamChunk: (data) => {
        currentStream += data
        setStreamOutput(currentStream)
      },
      onStreamEnd: () => {
        currentStream = ""
        setStreamOutput("")
      },
      moderationService: {
        openai,
        cooler: coolerOpenAIModerator
      }
    }, {
      useModerator: useModerator,
      // batchSizes: [2,3],
      createChatCompletionRequest: {
        model: model,
        temperature: temperature,
        stream: true
      },
    })

    if (systemInstruction) {
      translatorRef.current.systemInstruction = systemInstruction
    }

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
        setUsageInformation(translatorRef.current.usage)
        setRPMInformation(translatorRef.current.services.cooler?.rate)
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

  return (
    <>
      <div className='w-full'>
        <form id="translator-config-form" onSubmit={(e) => generate(e)}>
          <div className='px-4 pt-4 flex flex-wrap justify-between w-full gap-4'>
            <Card className="z-10 w-full shadow-md border" shadow="none">
              <CardHeader className="flex gap-3 pb-0">
                <div className="flex flex-col">
                  <p className="text-md">Configuration</p>
                </div>
              </CardHeader>
              <CardBody>
                <div className='flex flex-wrap justify-between w-full gap-4'>
                  <div className='flex flex-wrap md:flex-nowrap w-full gap-4'>
                    <Input
                      className="w-full md:w-6/12"
                      size='sm'
                      // autoFocus={true}
                      value={APIvalue}
                      onValueChange={(value) => setAPIKey(value)}
                      isRequired
                      autoComplete='off'
                      label="OpenAI API Key"
                      variant="flat"
                      description="API Key is stored locally in browser"
                      endContent={
                        <button className="focus:outline-none" type="button" onClick={toggleAPIInputVisibility}>
                          {isAPIInputVisible ? (
                            <EyeSlashFilledIcon className="text-2xl text-default-400 pointer-events-none" />
                          ) : (
                            <EyeFilledIcon className="text-2xl text-default-400 pointer-events-none" />
                          )}
                        </button>
                      }
                      type={isAPIInputVisible ? "text" : "password"}
                    />
                    <Input
                      className='w-full md:w-6/12'
                      size='sm'
                      type="text"
                      label="OpenAI Base Url"
                      placeholder="https://api.openai.com/v1"
                      autoComplete='on'
                      value={baseUrlValue ?? ""}
                      onValueChange={setBaseUrl}
                    />
                  </div>

                  <div className='flex w-full gap-4'>
                    <Input
                      className='w-full md:w-6/12'
                      size='sm'
                      type="text"
                      label="From Language"
                      placeholder="Auto"
                      autoComplete='on'
                      value={fromLanguage}
                      onValueChange={setFromLanguage}
                    />
                    <Input
                      className='w-full md:w-6/12'
                      size='sm'
                      type="text"
                      label="To Language"
                      autoComplete='on'
                      value={toLanguage}
                      onValueChange={setToLanguage}
                    />
                  </div>

                  <div className='w-full'>
                    <Textarea
                      label="System Instruction"
                      minRows={2}
                      description={"Override preset system instruction"}
                      placeholder={`Translate ${fromLanguage ? fromLanguage + " " : ""}to ${toLanguage}`}
                      value={systemInstruction}
                      onValueChange={setSystemInstruction}
                    />
                  </div>

                  <div className='flex flex-wrap md:flex-nowrap w-full gap-4'>
                    <div className='w-full md:w-4/12'>
                      <Input
                        size='sm'
                        type="text"
                        label="Model"
                        autoComplete='on'
                        value={model}
                        onValueChange={setModel}
                      />
                    </div>

                    <div className='w-full md:w-3/12'>
                      <Slider
                        label="Temperature"
                        size="md"
                        hideThumb={true}
                        step={0.1}
                        maxValue={2}
                        minValue={0}
                        value={temperature}
                        onChange={(e) => setTemperature(Number(e))}
                      />
                    </div>

                    <div className='w-full md:w-5/12 gap-4 flex flex-wrap md:flex-nowrap'>
                      <div className='w-full md:w-6/12 flex'>
                        <Switch
                          size='sm'
                          isSelected={useModerator}
                          onValueChange={setUseModerator}
                        >
                        </Switch>
                        <div className="flex flex-col place-content-center gap-1">
                          <p className="text-small">Use Moderator</p>
                          {baseUrlValue && (
                            <p className="text-tiny text-default-400">
                              Base URL is set, disable moderator for compatibility.
                            </p>
                          )}
                        </div>
                      </div>

                      <Input
                        className='w-full md:w-6/12'
                        size='sm'
                        type="number"
                        min="1"
                        label="Rate Limit"
                        value={rateLimit.toString()}
                        onValueChange={(value) => setRateLimitValue(value)}
                        autoComplete='on'
                        endContent={
                          <div className="pointer-events-none flex items-center">
                            <span className="text-default-400 text-small">RPM</span>
                          </div>
                        }
                      />
                    </div>
                  </div>
                </div>
              </CardBody>
            </Card>
          </div>
        </form>

        <div className='w-full justify-between md:justify-center flex flex-wrap gap-1 sm:gap-4 mt-auto sticky top-0 backdrop-blur px-4 pt-4'>
          <FileUploadButton label={"Import SRT"} onFileSelect={async (file) => {
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
            <Button type='submit' form="translator-config-form" color="primary" isDisabled={!APIvalue || translatorRunningState}>
              Start
            </Button>
          )}

          {translatorRunningState && (
            <Button color="danger" onClick={() => stopGeneration()} isLoading={!streamOutput}>
              Stop
            </Button>
          )}

          <Button color="primary" onClick={() => {
            // console.log(srtOutputText)
            downloadString(srtOutputText, "text/plain", "export.srt")
          }}>
            Export SRT
          </Button>
          <Divider className='mt-3 sm:mt-0' />
        </div>

        <div className="lg:flex lg:gap-4 px-4 mt-4">
          <div className="lg:w-1/2">
            <SubtitleCard label={"Input"}>
              <ol className="py-2 list-decimal line-marker ">
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

          <div className="lg:w-1/2">
            <SubtitleCard label={"Output"}>
              <ol className="py-2 list-decimal line-marker ">
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

            {usageInformation && (
              <Card shadow="sm" className='mt-4 p-4'>
                <span><b>Estimated Usage</b></span>
                <span>Tokens: {usageInformation?.usedTokens} ${usageInformation?.usedTokensPricing}</span>
                {usageInformation?.wastedTokens > 0 && (
                  <span className={'text-danger'}>Wasted: {usageInformation?.wastedTokens} ${usageInformation?.wastedTokensPricing} {usageInformation?.wastedPercent}</span>
                )}
                <span>{usageInformation?.rate} TPM {RPMInfomation} RPM</span>
              </Card>
            )}

          </div>
        </div>
      </div>
    </>
  )
}
