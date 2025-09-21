import OpenAI from "openai";

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const model = "gpt-4o-mini";

export const analyzeImage = async (image) => {
    const payload = {
        model: model,
        input: [
            {
                role: "user",
                content: [
                    {type: "input_text", text: "What landmark or famous place is on this image? Return only the name of the place, nothing else."},
                    {
                        type: "input_image",
                        image_url: `data:image/jpeg;base64,${image}`,
                    },
                ],
            },
        ],
    }
    // console.log("payload = " + JSON.stringify(payload));
    const response = await openai.responses.create(payload);
    console.log("response.output_text = " + JSON.stringify(response));
    return response.output_text;
}

export const answerToPrompt = async (systemPrompt, userPrompt) => {
    const response = await openai.chat.completions.create({
        model: model,
        messages: [
            {
                role: "system",
                content: [
                    {
                        type: "text",
                        text: systemPrompt
                    }
                ]
            },
            {
                role: "user",
                content: [
                    {
                        type: "text",
                        text: userPrompt
                    }
                ]
            }
        ]
    });
    console.log("response = " + JSON.stringify(response));
    return response.choices[0].message.content;
}