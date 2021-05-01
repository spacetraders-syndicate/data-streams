import { UsersApi, LoansApi, CreateUserTokenResponse, Configuration } from '@spacetraders-syndicate/openapi-sdk';
import { ulid } from 'ulid';
export type User = CreateUserTokenResponse;

const basePath = 'https://api.spacetraders.io';

export async function newUser(username?: string): Promise<User> {
    const configuration = new Configuration({
        basePath,
    });

    const usersClient = new UsersApi(configuration);
    const user = await usersClient.createUserToken({
        username: username || ulid(),
    });
    return user.data;
}

export async function newUserAndConfiguration(
    username?: string,
): Promise<{
    user: User;
    config: Configuration;
}> {
    const user = await newUser(username);
    const config = new Configuration({
        accessToken: user.token,
        basePath,
    });

    return {
        user,
        config,
    };
}

export async function newUserAndConfigAcceptedLoan(
    username?: string
): Promise<{
    user: User;
    config: Configuration;
}> {
    const response = await newUserAndConfiguration(username);
    const loansClient = new LoansApi(response.config);
    const {
        data: { loans },
    } = await loansClient.listGameLoans();
    await loansClient.createUserLoan({
        username: response.user.user.username,
        createUserLoanPayload: {
            type: loans[0].type,
        },
    });
    return response;
}
