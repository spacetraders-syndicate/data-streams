import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const client = new EventBridgeClient({});

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
    throw Error('must define process.env.AWS_LAMBDA_FUNCTION_NAME')
}

const source = process.env.AWS_LAMBDA_FUNCTION_NAME;

export async function reinvokeSelf(bestAttemptContextPass: Record<string, unknown>) {
    const events = new PutEventsCommand({
        Entries: [
            {
                Source: source,
                DetailType: 'reinvokeSelf',
                Detail: JSON.stringify(bestAttemptContextPass || {})
            }
        ]
    })
    return await client.send(events);
}