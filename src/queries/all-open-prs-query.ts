import { gql, TypedDocumentNode } from "@apollo/client/core";
import { client } from "../graphql-client";
import { GetAllOpenPRs, GetAllOpenPRsVariables } from "./schema/GetAllOpenPRs";

export const getAllOpenPRsQuery: TypedDocumentNode<GetAllOpenPRs, GetAllOpenPRsVariables> = gql`
query GetAllOpenPRs($after: String) {
  repository(owner: "DefinitelyTyped", name: "DefinitelyTyped") {
    id
    pullRequests(orderBy: { field: UPDATED_AT, direction: DESC }, states: [OPEN], first: 100, after: $after) {
      edges {
        cursor
        node {
          number
          updatedAt
        }
      }
    }
  }
}`;

export async function getAllOpenPRs() {
    const prNumbers: number[] = [];
    let after: string | undefined;
    while (true) {
        const results = await client.query({
            query: getAllOpenPRsQuery,
            fetchPolicy: "network-only",
            variables: { after }
        });

        if (!results.data.repository?.pullRequests.edges?.length) {
            return prNumbers;
        }

        for (const edge of results.data.repository.pullRequests.edges) {
            if (!edge) continue;
            const { node, cursor } = edge;
            after = cursor;
            if (!node) continue;

            prNumbers.push(node.number);
        }
    }
}
