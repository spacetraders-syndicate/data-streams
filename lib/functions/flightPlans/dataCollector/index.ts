import { Context, EventBridgeEvent, ScheduledEvent } from 'aws-lambda';
import { connections, configs, ships, users, time, lambda } from '../../utils';
import { ApiGatewayManagementApiClient, PostToConnectionCommandOutput, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { FlightPlansApi, Configuration, SystemsApi, System, GameFlightPlan } from "@spacetraders-syndicate/openapi-sdk";
import { ulid } from 'ulid';
import Axios from 'axios';
import axiosRetry from 'axios-retry';

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


type ApiUser = {
    username: string;
    token: string
}

type ConfigCache = {
    apiUser?: ApiUser,
    apiConfiguration?: Configuration,
    systems?: {
        symbols: System["symbol"][];
    },
    ships?: boolean;
}

type ShipFlightPlanEvent = GameFlightPlan & {
    type: "LAUNCHED" | "LANDED"
}

let configCache: ConfigCache;
let flightPlansCache: GameFlightPlan[];

exports.handler = async (event: EventBridgeEvent<'reinvokeSelf', {
    flightPlansCache: GameFlightPlan[]
}>, context: Context) => {

    if (event.detail?.flightPlansCache) {
        console.log(`context passed invoke`)
        console.log(event.detail.flightPlansCache);
        flightPlansCache = event.detail.flightPlansCache;
    }

    // we get the configs cache if needed, create a user if needed
    // then populate the cache
    if (!configCache) {
        const configsResponse = await configs.fetch();
        if (!configsResponse.apiUser) {
            const usersApi = await users.newUserAndConfigAcceptedLoan(`syndicate.flightplans.${ulid()}`)
            const apiUser: ApiUser = {
                username: usersApi.user.user.username,
                token: usersApi.user.token
            }

            await configs.create('apiUser', apiUser)
            configCache = {
                apiUser: configsResponse.apiUser as ApiUser
            };
        }

        configCache = {
            apiUser: configsResponse.apiUser as ApiUser,
            ships: configsResponse.ships ? true : false,
            systems: configsResponse.systems ? configsResponse.systems as ConfigCache["systems"] : undefined,
        };
    }

    if (!configCache.apiUser) {
        const config = await configs.fetch();
        configCache.apiUser = config.apiUser as ApiUser
    }


    if (!configCache.apiConfiguration) {
        configCache.apiConfiguration = new Configuration({
            accessToken: configCache.apiUser.token
        })
    }

    if (!configCache.systems) {
        const systemsListResponse = await new SystemsApi(configCache.apiConfiguration).listGameSystems();
        const symbols = {
            symbols: systemsListResponse.data.systems.map((system) => {
                return system.symbol
            })
        };
        await configs.create('systems', symbols);
        configCache.systems = symbols;
    }

    // buy ships if we need them, really only ever runs once
    // we do this after we get the system cache
    if (!configCache.ships) {
        configCache.systems.symbols.forEach(async (system) => {
            await ships.buyCheapestShip({
                username: configCache.apiUser!.username
            }, configCache.apiConfiguration!, system)
        })
        await configs.create('ships', {
            purchased: true
        })
        configCache.ships = true;
    }

    while (context.getRemainingTimeInMillis() > 5000) {
        const flightPlans = await getFlightPlans();

        if (flightPlansCache) {
            const launchedEvents = launchedShips(flightPlans);
            const landedEvents = landedShips(flightPlans);
            const allEvents = [...launchedEvents, ...landedEvents];
            if(allEvents.length > 0){
                await sendMessagesToAllConnections(allEvents)
            }
        }

        flightPlansCache = flightPlans;
        await time.sleep(500)
    }


    // issue lambda async event againt myself right before exist
    // async will retry and I'll invoke myself (concurency 1)
    try {
        const response = await lambda.reinvokeSelf({
            flightPlansCache
        });
    } catch (e) {
        console.error(`failed in reinvoke self`)
        console.error(e.message)
    }
}


function comparer(target: any[]) {
    return function (current: any) {
        return target.filter(function (other: any) {
            return other.id == current.id
        }).length == 0;
    }
}

function launchedShips(currentFlightPlans: GameFlightPlan[]): ShipFlightPlanEvent[] {
    return currentFlightPlans.filter(comparer(flightPlansCache)).map((plan) => {
        return {
            ...plan,
            type: "LAUNCHED"
        }
    })
}

function landedShips(currentFlightPlans: GameFlightPlan[]): ShipFlightPlanEvent[] {
    return flightPlansCache.filter(comparer(currentFlightPlans)).map((plan) => {
        return {
            ...plan,
            type: "LANDED"
        }
    })
}

async function getFlightPlans() {
    let promises: Promise<GameFlightPlan[]>[] = [];
    promises = promises.concat(configCache!.systems!.symbols.map(async (system) => {
        const { data: { flightPlans } } = await new FlightPlansApi(configCache.apiConfiguration, undefined, axios).listGameSystemFlightPlans({
            symbol: system
        });
        return flightPlans;
    }))
    const systemFlightPlans = await Promise.all(promises);
    return systemFlightPlans.reduce((a, b) => {
        return a.concat(b)
    })
}

async function sendMessagesToAllConnections(messages: any[]) {
    const connectionIds = await connections.fetch();
    const connectionMessageBlocks = connectionIds.map((connectionId) => {
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