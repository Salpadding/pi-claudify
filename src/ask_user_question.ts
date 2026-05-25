import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "@sinclair/typebox";

const optionSchema = Type.Object({
    label: Type.String({ description: "The display text for this option that the user will see and select. Keep it concise and distinct." }),
    description: Type.Optional(Type.String({ description: "Short explanation of what this option means or what will happen if chosen." })),
    preview: Type.Optional(Type.String({ description: "Optional markdown preview content for this option. It may be shown by richer UIs." })),
});

const questionSchema = Type.Object({
    question: Type.String({ description: "The complete question to ask the user. Should be clear and specific." }),
    header: Type.Optional(Type.String({ description: "Very short label/category for this question, e.g. 'Auth method', 'Library', 'Approach'." })),
    options: Type.Array(optionSchema, {
        minItems: 2,
        maxItems: 4,
        description: "Available choices for the user. Provide 2-4 concrete options. Do not include 'Other'; it is provided automatically.",
    }),
    multiSelect: Type.Optional(Type.Boolean({ description: "Set true to allow selecting multiple options." })),
});

const askUserQuestionSchema = Type.Object({
    questions: Type.Array(questionSchema, {
        minItems: 1,
        maxItems: 4,
        description: "Questions to ask the user. Batch related clarification questions together.",
    }),
});

type AskUserQuestionParams = Static<typeof askUserQuestionSchema>;
type Question = AskUserQuestionParams["questions"][number];
type QuestionOption = Question["options"][number];

type AskUserQuestionDetails = {
    questions: Question[];
    answers: Record<string, string>;
    cancelled?: boolean;
};

type DialogOptions = { signal?: AbortSignal };

const OTHER_LABEL = "Other (type custom answer)";
const DONE_LABEL = "Done";
const CANCEL_LABEL = "Cancel";

function optionDisplay(option: QuestionOption, index: number): string {
    const prefix = `${index + 1}. ${option.label}`;
    return option.description ? `${prefix} — ${option.description}` : prefix;
}

function questionTitle(question: Question, index: number, total: number): string {
    const header = question.header ? `[${question.header}] ` : "";
    const counter = total > 1 ? ` (${index + 1}/${total})` : "";
    return `${header}${question.question}${counter}`;
}

function validateQuestions(questions: Question[]): string | undefined {
    const questionTexts = new Set<string>();
    for (const question of questions) {
        if (questionTexts.has(question.question)) return `Duplicate question text: ${question.question}`;
        questionTexts.add(question.question);

        if (question.options.length < 2 || question.options.length > 4) {
            return `Question "${question.question}" must have 2-4 options.`;
        }

        const labels = new Set<string>();
        for (const option of question.options) {
            if (labels.has(option.label)) return `Duplicate option label "${option.label}" in question "${question.question}".`;
            labels.add(option.label);
        }
    }
    return undefined;
}

async function askSingleChoice(
    ctx: ExtensionContext,
    question: Question,
    index: number,
    total: number,
    opts: DialogOptions,
): Promise<string | undefined> {
    const displays = question.options.map(optionDisplay);
    const choice = await ctx.ui.select(questionTitle(question, index, total), [...displays, OTHER_LABEL, CANCEL_LABEL], opts);
    if (!choice || choice === CANCEL_LABEL) return undefined;

    if (choice === OTHER_LABEL) {
        const custom = await ctx.ui.input(questionTitle(question, index, total), "Type your answer...", opts);
        const trimmed = custom?.trim();
        return trimmed || undefined;
    }

    const selectedIndex = displays.indexOf(choice);
    if (selectedIndex < 0) return undefined;
    return question.options[selectedIndex]?.label;
}

async function askMultiChoice(
    ctx: ExtensionContext,
    question: Question,
    index: number,
    total: number,
    opts: DialogOptions,
): Promise<string | undefined> {
    const selected = new Set<number>();
    const customAnswers: string[] = [];

    while (true) {
        const optionDisplays = question.options.map((option, optionIndex) => {
            const checkbox = selected.has(optionIndex) ? "[x]" : "[ ]";
            const base = `${checkbox} ${optionDisplay(option, optionIndex)}`;
            return option.description ? base : base;
        });
        const customDisplays = customAnswers.map((answer, customIndex) => `[x] Custom ${customIndex + 1}: ${answer}`);
        const choice = await ctx.ui.select(
            `${questionTitle(question, index, total)}\nSelect all that apply, then choose Done.`,
            [...optionDisplays, ...customDisplays, OTHER_LABEL, DONE_LABEL, CANCEL_LABEL],
            opts,
        );

        if (!choice || choice === CANCEL_LABEL) return undefined;
        if (choice === DONE_LABEL) {
            const labels = [...selected].sort((a, b) => a - b).map((i) => question.options[i]?.label).filter(Boolean) as string[];
            labels.push(...customAnswers);
            return labels.length > 0 ? labels.join(", ") : "None selected";
        }
        if (choice === OTHER_LABEL) {
            const custom = await ctx.ui.input(questionTitle(question, index, total), "Type an additional answer...", opts);
            const trimmed = custom?.trim();
            if (trimmed) customAnswers.push(trimmed);
            continue;
        }

        const optionIndex = optionDisplays.indexOf(choice);
        if (optionIndex >= 0) {
            if (selected.has(optionIndex)) selected.delete(optionIndex);
            else selected.add(optionIndex);
        }
    }
}

function answersText(answers: Record<string, string>): string {
    const lines = Object.entries(answers).map(([question, answer]) => `- ${question} → ${answer}`);
    return `User has answered your questions:\n${lines.join("\n")}\n\nContinue with these answers in mind.`;
}

export function registerAskUserQuestionTool(pi: ExtensionAPI): void {
    pi.registerTool<typeof askUserQuestionSchema, AskUserQuestionDetails>({
        name: "AskUserQuestion",
        label: "Ask User",
        description: "Ask the user multiple-choice questions to clarify requirements, gather preferences, make decisions, or choose an implementation direction.",
        promptSnippet: "Ask the user one or more multiple-choice questions",
        promptGuidelines: [
            "Use AskUserQuestion when you need user clarification, preferences, requirements, or a decision to proceed.",
            "Prefer batching related questions into one AskUserQuestion call instead of asking one at a time.",
            "Provide 2-4 concrete options for each question; do not include an Other option because the tool adds it automatically.",
            "Users can choose Other to provide free-text input.",
            "Use multiSelect: true only when multiple answers can apply.",
            "If you recommend a choice, put it first and mark it '(Recommended)'.",
        ],
        parameters: askUserQuestionSchema,
        executionMode: "sequential",

        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            if (!ctx.hasUI) {
                return {
                    content: [{ type: "text", text: "Error: AskUserQuestion requires interactive UI, but UI is not available." }],
                    details: { questions: params.questions, answers: {}, cancelled: true },
                };
            }

            const validationError = validateQuestions(params.questions);
            if (validationError) {
                return {
                    content: [{ type: "text", text: `Error: ${validationError}` }],
                    details: { questions: params.questions, answers: {}, cancelled: true },
                };
            }

            const answers: Record<string, string> = {};
            const opts = { signal };

            for (let i = 0; i < params.questions.length; i++) {
                if (signal?.aborted) {
                    return {
                        content: [{ type: "text", text: "User question was cancelled because the tool call was aborted." }],
                        details: { questions: params.questions, answers, cancelled: true },
                    };
                }

                const question = params.questions[i]!;
                const answer = question.multiSelect
                    ? await askMultiChoice(ctx, question, i, params.questions.length, opts)
                    : await askSingleChoice(ctx, question, i, params.questions.length, opts);

                if (answer === undefined) {
                    return {
                        content: [{ type: "text", text: "User cancelled the question dialog." }],
                        details: { questions: params.questions, answers, cancelled: true },
                    };
                }
                answers[question.question] = answer;
            }

            return {
                content: [{ type: "text", text: answersText(answers) }],
                details: { questions: params.questions, answers },
            };
        },

        renderCall(args, theme) {
            const questions = Array.isArray(args.questions) ? args.questions : [];
            const title = theme.fg("toolTitle", theme.bold("AskUserQuestion"));
            const lines = questions.map((q, i) => {
                const options = Array.isArray(q.options) ? q.options.map((o) => o.label).join(", ") : "";
                const multi = q.multiSelect ? " (multi-select)" : "";
                return theme.fg("muted", `  ${i + 1}. ${q.question}${multi}${options ? ` [${options}]` : ""}`);
            });
            return new Text([title, ...lines].join("\n"), 0, 0);
        },

        renderResult(result, _options, theme) {
            const details = result.details;
            if (!details) {
                const first = result.content[0];
                return new Text(first?.type === "text" ? first.text : "", 0, 0);
            }
            if (details.cancelled) {
                return new Text(theme.fg("warning", "User cancelled AskUserQuestion"), 0, 0);
            }
            const lines = Object.entries(details.answers).map(([question, answer]) => `  ${question} → ${answer}`);
            return new Text(theme.fg("success", "✓ User answered") + (lines.length ? `\n${theme.fg("accent", lines.join("\n"))}` : ""), 0, 0);
        },
    });
}
