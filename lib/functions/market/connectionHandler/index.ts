import { APIGatewayEventRequestContext, APIGatewayProxyEventV2 } from 'aws-lambda';
import { connections, cache } from "../../utils";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import Axios from 'axios';
import axiosRetry from 'axios-retry';
import { GetGameLocationMarketplaceResponseLocation, MarketplaceGood } from '@spacetraders-syndicate/openapi-sdk';

const axios = Axios.create();
axiosRetry(axios, {
    retries: 10,
    retryCondition: (e) => {
        return (
            axiosRetry.isNetworkOrIdempotentRequestError(e) ||
            e.response?.status == 429
        );
    },
    retryDelay: (retryCount) => {
        return axiosRetry.exponentialDelay(retryCount);
    }
});
const endpoint = process.env.FULLY_QUALIFIED_DOMAIN_NAME ?
    `https://${process.env.FULLY_QUALIFIED_DOMAIN_NAME}` : `https://${process.env.API_ID}.execute-api.${process.env.AWS_REGION}.amazonaws.com/${process.env.API_STAGE}`;
const apig = new ApiGatewayManagementApiClient({
    apiVersion: "2018-11-29",
    endpoint,
});


function marshall(payload: any) {
    return Buffer.from(JSON.stringify(
        payload
    ))
}

exports.handler = async (event: APIGatewayProxyEventV2 & { requestContext: APIGatewayEventRequestContext }) => {

    if (event.requestContext.eventType == "CONNECT") {
        await connections.create(event.requestContext.connectionId);
    }

    if (event.requestContext.eventType == "DISCONNECT") {
        await connections.destroy(event.requestContext.connectionId);
    }


    console.log(event)
    if (event.requestContext.eventType == "MESSAGE") {
        if(event.body == 'sync'){
            const locations = await cache.fetch();
            const mappedLocations = Object.keys(locations).map((symbol) => {
                const returns: Record<string, MarketplaceGood[]> = {};
                returns[symbol] =  (locations[symbol] as GetGameLocationMarketplaceResponseLocation).marketplace
                return returns;
            })
            await sendMessage(event, mappedLocations);
        }

        if(event.body == 'sync-locations'){
            const locations = await cache.fetch();
            const mappedLocations = Object.keys(locations).map((symbol) => {
                return  locations[symbol] as GetGameLocationMarketplaceResponseLocation
            })
            await sendMessage(event, {
                locations: mappedLocations
            });
        }
    }

    const response = {
        statusCode: 200,
    };
    return response;
}


async function sendMessage(event: APIGatewayProxyEventV2 & { requestContext: APIGatewayEventRequestContext }, message: any) {
    const connectionId = event.requestContext.connectionId;
    const command = new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: marshall(message)
    })
    return apig.send(command).catch(async (e) => {
        console.log(e);
        if (e.errorMessage == "GoneException") {
            await connections.destroy(connectionId)
        }
    });
}
