import { APIGatewayEventRequestContext, APIGatewayProxyEventV2 } from 'aws-lambda';
import { connections } from "../../utils";

exports.handler = async (event: APIGatewayProxyEventV2 & { requestContext: APIGatewayEventRequestContext } ) => {

    if(event.requestContext.eventType == "CONNECT"){
        await connections.create(event.requestContext.connectionId);
    }

    if(event.requestContext.eventType == "DISCONNECT"){
        await connections.destroy(event.requestContext.connectionId);
    }
       
    const response = {
        statusCode: 200,
    };
    return response;
}
