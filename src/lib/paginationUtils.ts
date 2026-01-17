import {
  AttributeValue,
  DynamoDBClient,
  ScanCommand,
  ScanCommandInput,
} from '@aws-sdk/client-dynamodb';

export const queryPaginatedDynamoList = async (
  client: DynamoDBClient,
  params: ScanCommandInput,
  offset: number,
  limit: number,
): Promise<{ results: Record<string, AttributeValue>[]; totItems: number }> => {
  let lastEvaluatedKey: number | null = null;
  let totItems = 0;
  let results: Record<string, AttributeValue>[] = [];
  let data;
  while (totItems < offset) {
    // scan the database for student items
    data = await client.send(
      new ScanCommand({
        ...params,
        ...(lastEvaluatedKey != null && {
          ExclusiveStartKey: {
            id: { N: lastEvaluatedKey?.toString() as string },
          },
        }),
      }),
    );

    if (data?.Count == undefined || data?.Items == undefined) {
      console.error(
        `query returned no results: offset ${offset} out of bounds`,
      );
      return { results: [], totItems: 0 };
    }

    totItems += data.Count;

    if (data.LastEvaluatedKey) {
      lastEvaluatedKey = data.LastEvaluatedKey['id'].N
        ? +data.LastEvaluatedKey['id'].N
        : null;
    }
  }

  if (data?.Items == undefined) {
    console.error(`query returned no results: offset ${offset} out of bounds`);
    return { results: [], totItems: 0 };
  }

  offset = totItems - offset;

  // if items count is less than limit and lastEvaluatedKey is not null: keep querying
  results.concat(
    data.Items.slice(offset, limit) as ConcatArray<
      Record<string, AttributeValue>
    >,
  );
  // itemsFound is the number of items that are in range for this query
  let itemsFound = results.length;

  while (itemsFound < limit && lastEvaluatedKey != null) {
    data = await client.send(
      new ScanCommand({
        ...params,
        Limit: limit - itemsFound,
        ...(lastEvaluatedKey != null && {
          ExclusiveStartKey: {
            id: { N: lastEvaluatedKey?.toString() as string },
          },
        }),
      }),
    );

    if (data?.Count == undefined || data?.Items == undefined) {
      console.error(
        `query returned no results: offset ${offset} out of bounds`,
      );
      return { results, totItems: totItems };
    }
    itemsFound += data.Count;
    totItems += data.Count;

    if (data.LastEvaluatedKey) {
      lastEvaluatedKey = data.LastEvaluatedKey['id'].N
        ? +data.LastEvaluatedKey['id'].N
        : null;
    }
  }

  return { results, totItems: totItems };
};
