import { ChatCompletionRequestMessage } from "openai"

export type DefaultPretext = {
    preprompt: ChatCompletionRequestMessage
    preoutput: ChatCompletionRequestMessage
}