WITH aggregated_stones AS (
  SELECT
    stones.starting_info_id,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id',
          stones.id,
          'type',
          stones.type,
          'customType',
          stones."customType",
          'color',
          stones.color,
          'shape',
          stones.shape,
          'size',
          stones.size,
          'quantity',
          stones.quantity,
          'cost',
          stones.cost,
          'notes',
          stones.notes
        )
        ORDER BY
          stones.id
      ) FILTER (
        WHERE
          (stones.id IS NOT NULL)
      ),
      '[]' :: jsonb
    ) AS stones
  FROM
    stones
  GROUP BY
    stones.starting_info_id
)
SELECT
  samples.id AS sample_id,
  samples."styleNumber",
  samples.name,
  samples.collection AS sample_collection,
  samples.category AS sample_category,
  samples.notes,
  samples.status AS sample_status,
  samples.created_at,
  samples.updated_at,
  samples."salesWeight",
  samples.starting_info_id,
  samples.selling_pair,
  samples.back_type,
  samples.custom_back_type,
  samples.back_type_quantity,
  samples."designId" AS sample_design_id,
  starting_info."manufacturerCode",
  starting_info.description AS starting_description,
  starting_info.karat,
  starting_info."metalType",
  starting_info.color,
  starting_info.vendor,
  starting_info."platingCharge",
  starting_info.length,
  starting_info.width,
  starting_info.height,
  starting_info.weight,
  starting_info.plating,
  starting_info."miscCost",
  starting_info."laborCost",
  starting_info."designId" AS starting_design_id,
  starting_info."totalCost",
  starting_info.necklace,
  starting_info."necklaceCost",
  starting_info.collection AS starting_collection,
  starting_info.category AS starting_category,
  COALESCE(agg.stones, '[]' :: jsonb) AS stones,
  COALESCE(ei.images, ARRAY [] :: text []) AS images,
  COALESCE(ei.cad, ARRAY [] :: text []) AS cad,
  p.tag_label AS plating_label,
  samples.ssp_code,
  samples.ssp_item_id
FROM
  (
    (
      (
        samples
        JOIN starting_info ON ((starting_info.id = samples.starting_info_id))
      )
      LEFT JOIN aggregated_stones agg ON (
        (agg.starting_info_id = samples.starting_info_id)
      )
    )
    LEFT JOIN entity_images ei ON (
      (
        (
          (ei."entityId") :: numeric = (samples.starting_info_id) :: numeric
        )
        AND (ei.entity = 'starting_info' :: text)
      )
    )
  )
  LEFT JOIN plating p ON ((p.id = starting_info.plating));
