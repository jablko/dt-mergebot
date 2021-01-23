import { gql, TypedDocumentNode } from "@apollo/client/core";
import { client } from "../graphql-client";
import { GetProjectBoardCards } from "./schema/GetProjectBoardCards";
import { noNullish } from "../util/util";

const GetProjectBoardCardsQuery: TypedDocumentNode<GetProjectBoardCards, never> = gql`
  query GetProjectBoardCards {
    repository(owner: "DefinitelyTyped", name: "DefinitelyTyped") {
      id
      project(number: 5) {
        id
        columns(first: 100) {
          nodes {
            id
            name
            cards(last: 100) {
              totalCount
              nodes {
                id
                updatedAt
                content {
                  ... on Closable {
                    closed
                  }
                }
              }
            }
          }
        }
      }
    }
  }`;

export async function getProjectBoardCards() {
    const results = await client.query({
        query: GetProjectBoardCardsQuery,
        fetchPolicy: "network-only",
    });

    const project = results.data.repository?.project;

    if (!project) {
        throw new Error("No project found");
    }

    return noNullish(project.columns.nodes).map(column => ({
        name: column.name,
        totalCount: column.cards.totalCount,
        cards: noNullish(column.cards.nodes).map(card => ({
            id: card.id,
            updatedAt: card.updatedAt,
            closed: card.content?.closed,
        })),
    }));
}
