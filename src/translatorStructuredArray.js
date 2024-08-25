import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

import { Translator } from "./translator.mjs";
import { TranslationOutput } from "./translatorOutput.mjs";
import { TranslatorStructuredBase } from "./translatorStructuredBase.js";

export class TranslatorStructuredArray extends TranslatorStructuredBase
{
    /**
     * @param {{from?: string, to: string}} language
     * @param {import("./translator.mjs").TranslationServiceContext} services
     * @param {Partial<import("./translator.mjs").TranslatorOptions>} [options]
     */
    constructor(language, services, options)
    {
        super(language, services, options)
    }
}