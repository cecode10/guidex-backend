import {BedrockRuntimeClient, InvokeModelCommand} from "@aws-sdk/client-bedrock-runtime";

const bedrockClient = new BedrockRuntimeClient({region: "us-east-2"});

export const feedToModel = async (prompt) => {
    const input = {
        modelId: "arn:aws:bedrock:us-east-2:864317837756:inference-profile/us.meta.llama3-3-70b-instruct-v1:0",
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
            prompt: prompt,
            max_gen_len: 4096,
            temperature: 0.2,
            top_p: 0.95,
        }),
    };
    const command = new InvokeModelCommand(input);
    const response = await bedrockClient.send(command);
    const responseBody = JSON.parse(Buffer.from(response.body).toString("utf-8"));
    return responseBody.generation;
}

