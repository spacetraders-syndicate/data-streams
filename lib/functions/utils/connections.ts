import { DynamoDBClient, UpdateItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { APIGatewayEventRequestContext } from 'aws-lambda'

const ddb = new DynamoDBClient({});

if (!process.env.TABLE_NAME) {
    throw Error('must define process.env.TABLE_NAME')
}
const TableName = process.env.TABLE_NAME;

function calculateKey(connectionId: APIGatewayEventRequestContext["connectionId"]) {
    return marshall({
        pk: 'connections',
        sk: 'a' // eventually we can bucket this if we need to scale
    })
}

export async function create(connectionId: APIGatewayEventRequestContext["connectionId"]) {
    const update = new UpdateItemCommand({
        TableName,
        Key: calculateKey(connectionId),
        UpdateExpression: "ADD ids :id",
        ExpressionAttributeValues: marshall({
            ":id": new Set([connectionId]),
        }),
    })
    return await ddb.send(update);
}

export async function destroy(connectionId: APIGatewayEventRequestContext["connectionId"]) {
    const update = new UpdateItemCommand({
        TableName,
        Key: calculateKey(connectionId),
        UpdateExpression: "DELETE ids :id",
        ExpressionAttributeValues: marshall({
            ":id": new Set([connectionId]),
        }),
    })
    return await ddb.send(update);
}

export async function fetch() {
    const update = new QueryCommand({
        TableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: marshall({
            ":pk": 'connections'
        })
    })
    const results = await ddb.send(update);
    if (results.Items) {
        let ids: string[] = [];
        results.Items.forEach(function (row, index, array) {
            const unmarshalled = unmarshall(row);
            if(unmarshalled.ids){
                ids = ids.concat(Array.from(unmarshalled.ids));
            }
        });

        return ids;
    } else {
        return []
    }
}