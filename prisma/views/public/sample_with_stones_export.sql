WITH aggregated_stones AS (
  SELECT
    stones.starting_info_id,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', stones.id,
          'type', stones.type,
          'customType', stones."customType",
          'color', stones.color,
          'shape', stones.shape,
          'size', stones.size,
          'quantity', stones.quantity,
          'cost', stones.cost,
          'notes', stones.notes
        )
        ORDER BY stones.id
      ) FILTER (WHERE (stones.id IS NOT NULL)),
      '[]'::jsonb
    ) AS stones
  FROM
    stones
  GROUP BY
    stones.starting_info_id
),
plating_specs AS (
  SELECT
    plating_layers.plating_id,
    jsonb_agg(
      jsonb_build_object(
        'sequence', plating_layers.sequence,
        'material', plating_layers.plating_material,
        'color', plating_layers.plating_color,
        'method', plating_layers.plating_method,
        'micron', plating_layers.plating_micron,
        'cost', plating_layers.plating_cost,
        'coverage', plating_layers.plating_coverage
      )
      ORDER BY plating_layers.sequence
    ) AS layers
  FROM
    plating_layers
  GROUP BY
    plating_layers.plating_id
)
SELECT
  samples.id AS sample_id,
  samples."styleNumber",
  samples.name,
  samples.collection AS sample_collection,
  samples.type AS sample_type,
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
  starting_info.type AS starting_type,
  starting_info.category AS starting_category,
  COALESCE(agg.stones, '[]'::jsonb) AS stones,
  COALESCE(ei.images, ARRAY[]::text[]) AS images,
  COALESCE(ei.cad, ARRAY[]::text[]) AS cad,
  p.tag_label AS plating_label,
  p.name AS plating_name,
  COALESCE(ps.layers, '[]'::jsonb) AS plating_layers,
  samples.ssp_code,
  samples.ssp_item_id,
  samples.ssp_material_id,
  samples.ssp_stone_ids,
  t.name AS type_name,
  t.ssp_product_type AS type_ssp_product_type,
  t.ssp_category AS type_default_category,
  t.unit_of_measure,
  COALESCE(fd_cat.finding_type, fd_type.finding_type) AS finding_type,
  COALESCE(fd_cat.finding_description, fd_type.finding_description) AS finding_description,
  COALESCE(fd_cat.material_type, fd_type.material_type) AS finding_material_type,
  COALESCE(fd_cat.size, fd_type.size) AS finding_size,
  COALESCE(fd_cat.net_weight, fd_type.net_weight) AS finding_net_weight,
  COALESCE(fd_cat.labor_cost, fd_type.labor_cost) AS finding_labor_cost,
  COALESCE(fd_cat.material_cost, fd_type.material_cost) AS finding_material_cost,
  t.finishing_type,
  t.finishing_cost,
  t.casting_cost,
  t.assembly_charge,
  t.labor_per_gram,
  t.stone_category AS type_stone_category,
  t.stone_clarity AS type_stone_clarity,
  t.setting_type AS type_setting_type,
  t.setting_method AS type_setting_method,
  t.setting_charge_per_stone AS type_setting_charge,
  t.packaging_desc,
  t.packaging_cost,
  t.tag_qty,
  t.tag_cost,
  t.duty_rate AS type_duty_rate,
  t.country_of_origin AS type_country,
  md.material_type AS metal_material_type,
  md.metal_purity,
  md.metal_karat,
  md.metal_color,
  md.nickel_content,
  md.metal_loss_percent,
  md.costing_method,
  starting_info."salesPrice"
FROM
  samples
  JOIN starting_info ON starting_info.id = samples.starting_info_id
  LEFT JOIN aggregated_stones agg ON agg.starting_info_id = samples.starting_info_id
  LEFT JOIN entity_images ei ON ei."entityId"::numeric = samples.starting_info_id::numeric
    AND ei.entity = 'starting_info'::text
  LEFT JOIN plating p ON p.id = starting_info.plating
  LEFT JOIN plating_specs ps ON ps.plating_id = starting_info.plating
  LEFT JOIN category t ON t.id = starting_info.type
  LEFT JOIN ssp_metal_defaults md ON md.metal_type = starting_info."metalType"::text
    AND md.karat = starting_info.karat::text
  LEFT JOIN ssp_finding_defaults fd_cat ON fd_cat.ssp_product_type = t.ssp_product_type
    AND fd_cat.ssp_category = COALESCE(starting_info.category, t.ssp_category)
  LEFT JOIN ssp_finding_defaults fd_type ON fd_type.ssp_product_type = t.ssp_product_type
    AND fd_type.ssp_category IS NULL;
