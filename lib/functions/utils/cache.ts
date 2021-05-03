import { DynamoDBClient, UpdateItemCommand, DeleteItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const ddb = new DynamoDBClient({});

if (!process.env.TABLE_NAME) {
    throw Error('must define process.env.TABLE_NAME')
}
const TableName = process.env.TABLE_NAME;

function calculateKey(key: string) {
    return marshall({
        pk: 'cache',
        sk: key
    })
}

export async function create(key: string, content: any) {
    const update = new UpdateItemCommand({
        TableName,
        Key: calculateKey(key),
        UpdateExpression: `SET content = :content`,
        ExpressionAttributeValues: marshall({
            ":content": content,
        }),
    })
    return await ddb.send(update);
}

export async function destroy(key: string) {
    const update = new DeleteItemCommand({
        TableName,
        Key: calculateKey(key),
    })
    return await ddb.send(update);
}

export async function fetch() {
    const update = new QueryCommand({
        TableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: marshall({
            ":pk": 'cache'
        })
    })
    const results = await ddb.send(update);
    if (results.Items) {
        const configs: Record<string, unknown> = {};
        results.Items.forEach(function (row, index, array) {
            const unmarshalled = unmarshall(row);
            const key = unmarshalled.sk as string;
            configs[key] = unmarshalled.content;
        });

        return configs;
    } else {
        return {}
    }
}