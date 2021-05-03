import { Context, EventBridgeEvent } from 'aws-lambda';
import { connections, time } from '../../utils';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { Configuration, GetGameLocationMarketplaceResponseLocation, Location, MarketplaceApi, MarketplaceGood } from '@spacetraders-syndicate/openapi-sdk'
import Axios from 'axios';
import axiosRetry from 'axios-retry';
import deepEqual = require("deep-equal");
import { reinvokeSelf } from '../../utils/lambda';
import { cache } from '../../utils';

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

if (!process.env.LOCATIONS || !process.env.TOKEN) {
    console.log(`process.env.LOCATIONS must be defined as an array of strings`);
    console.log(`process.env.TOKEN must be defined as an array of strings`);
    throw new Error('must set process.env variables');
}

const locations = JSON.parse(process.env.LOCATIONS!) as Location["symbol"][];
const accessToken = process.env.TOKEN;
const apiConfig = new Configuration({
    accessToken
})

type Market = Partial<Record<GetGameLocationMarketplaceResponseLocation["symbol"], GetGameLocationMarketplaceResponseLocation>>
let marketCache: Market = {};

exports.handler = async (event: EventBridgeEvent<'reinvokeSelf', { marketCache?: Market }>, context: Context) => {

    let forceCacheSync = false;
    if(event.detail.marketCache){
        marketCache = event.detail.marketCache;
    } else {
        // rebuild dynamodb
        forceCacheSync = true;
    }

    while (context.getRemainingTimeInMillis() > 5000) {
        const responses = locations.map((symbol) => {
            // pull in our own axios with retries and exponential backoff
            return new MarketplaceApi(apiConfig, undefined, axios).getGameLocationMarketplace({
                symbol
            })
        })

        const marketDataResponses = await Promise.all(responses);
        let differences: Record<GetGameLocationMarketplaceResponseLocation["symbol"], MarketplaceGood[]> = {};
        marketDataResponses.map((response) => {
            const locationDifferences = calculateDifferences(response.data.location);
            marketCache[response.data.location.symbol] = response.data.location;
            if(locationDifferences.length > 0){
                differences[response.data.location.symbol] = locationDifferences;
                cache.create(response.data.location.symbol, response.data.location);
            }

            if(forceCacheSync){
                cache.create(response.data.location.symbol, response.data.location);
            }
        })

        if (Object.keys(differences).length > 0) {
            await sendMessagesToAllConnections([differences])
        }
        await time.sleep(3000)
    }
    await reinvokeSelf({
        marketCache
    })
}


function calculateDifferences(currentMarket: GetGameLocationMarketplaceResponseLocation): MarketplaceGood[] {
    if (marketCache[currentMarket.symbol] == undefined) {
        return []
    }

    const differences: MarketplaceGood[] = [];
    const fromCache = marketCache[currentMarket.symbol]!.marketplace;
    currentMarket.marketplace.map((good) => {
        const match = fromCache.find((search) => good.symbol === search.symbol)
        if (match && isDifferent(match, good)) {
            differences.push(good)
        }
    })

    return differences;
}

function isDifferent(match: MarketplaceGood, good: MarketplaceGood) {
    return ((match.purchasePricePerUnit !== good.purchasePricePerUnit) || (match.sellPricePerUnit !== good.sellPricePerUnit))
}

async function sendMessagesToAllConnections(messages: any[]) {
    const connectionIds = await connections.fetch();
    const connectionMessageBlocks = connectionIds.map(async (connectionId) => {
        const command = new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: marshall(messages)
        })
        return apig.send(command).catch(async (e) => {
            if (e.errorMessage == "GoneException") {
                await connections.destroy(connectionId)
            }
        });
    })

    await Promise.all(connectionMessageBlocks);
}