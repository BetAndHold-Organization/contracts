import { GraphQLClient } from "graphql-request";

const endpoint = import.meta.env.VITE_GRAPHQL_URL ?? "http://localhost:4000/graphql";

export const graphqlClient = new GraphQLClient(endpoint, {
  fetch: async (input, init) => {
    const response = await fetch(input, init);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GraphQL request failed: ${response.status} ${errorText}`);
    }
    return response;
  },
});

export function getGraphQLClient() {
  return graphqlClient;
}

