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
): Promise<Record<string, AttributeValue>[]> => {
  let lastEvaluatedKey: number | null = null;
  let itemsScanned = 0;
  let results: Record<string, AttributeValue>[] = [];
  let data;

  // Skip items until we reach the offset
  while (itemsScanned < offset) {
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
      return [];
    }

    itemsScanned += data.Count;

    if (data.LastEvaluatedKey) {
      lastEvaluatedKey = data.LastEvaluatedKey['id'].N
        ? +data.LastEvaluatedKey['id'].N
        : null;
    } else {
      // No more items and we haven't reached offset
      if (itemsScanned < offset) {
        return [];
      }
    }
  }

  if (data?.Items == undefined) {
    console.error(`query returned no results: offset ${offset} out of bounds`);
    return [];
  }

  // Calculate how many items to skip from the last scanned batch
  const skipInBatch = itemsScanned - offset;

  // Add items from the current batch starting from the correct position
  results = results.concat(
    data.Items.slice(data.Items.length - skipInBatch, data.Items.length - skipInBatch + limit) as ConcatArray<
      Record<string, AttributeValue>
    >,
  );

  // Continue fetching if we need more items
  while (results.length < limit && lastEvaluatedKey != null) {
    data = await client.send(
      new ScanCommand({
        ...params,
        Limit: limit - results.length,
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
      return results;
    }

    results = results.concat(
      data.Items as ConcatArray<Record<string, AttributeValue>>,
    );

    if (data.LastEvaluatedKey) {
      lastEvaluatedKey = data.LastEvaluatedKey['id'].N
        ? +data.LastEvaluatedKey['id'].N
        : null;
    } else {
      lastEvaluatedKey = null;
    }
  }

  return results;
};
