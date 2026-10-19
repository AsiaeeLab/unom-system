"""Task 10: RxNorm code lists for the medication features (vocabulary only, no participant data).

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 10).
Replaces the Task 02 drug code list, which exceeded the export row limit because it
included RxNorm Extension concepts. Keeps US RxNorm drug concepts only.
"""
import json
import os
import subprocess

from google.cloud import bigquery

CDR_ID = os.environ.get("UNM_CDR_ID", "R2025Q4R6")
HERE = os.path.dirname(os.path.abspath(__file__))
EXPORT = os.path.expanduser("~/unm/export/10")
REG = json.load(open(os.path.join(HERE, "features.json")))
CLASSES = ("Ingredient", "Clinical Drug", "Branded Drug", "Clinical Drug Comp", "Branded Drug Comp",
           "Clinical Drug Form", "Branded Drug Form", "Quant Clinical Drug", "Quant Branded Drug",
           "Clinical Pack", "Branded Pack")

cdr = subprocess.check_output(["wb", "resolve", f"--id={CDR_ID}"], text=True).strip()
client = bigquery.Client()
rows = ", ".join(f"STRUCT('{f['id']}' AS fid, '{n.lower()}' AS name)"
                 for f in REG["new_medications"] for n in f["rxnorm_ingredients"])
df = client.query(f"""
    WITH ing AS (SELECT * FROM UNNEST([{rows}])),
    ic AS (SELECT i.fid, i.name, c.concept_id AS ingredient_id FROM ing i JOIN `{cdr}.concept` c
           ON c.vocabulary_id = 'RxNorm' AND c.concept_class_id = 'Ingredient' AND LOWER(c.concept_name) = i.name)
    SELECT DISTINCT ic.fid, ic.name AS ingredient, d.concept_code AS rxcui, d.concept_class_id AS tty
    FROM ic JOIN `{cdr}.concept_ancestor` a ON a.ancestor_concept_id = ic.ingredient_id
    JOIN `{cdr}.concept` d ON d.concept_id = a.descendant_concept_id
    WHERE d.vocabulary_id = 'RxNorm' AND d.concept_class_id IN UNNEST(@classes)
""", job_config=bigquery.QueryJobConfig(query_parameters=[
    bigquery.ArrayQueryParameter("classes", "STRING", list(CLASSES))])).to_dataframe()
df["rxcui"] = "rxcui:" + df.rxcui.astype(str)
os.makedirs(EXPORT, exist_ok=True)
df = df.sort_values(["fid", "ingredient", "rxcui"])
chunk = 30000
for k in range(0, len(df), chunk):
    df.iloc[k:k + chunk].to_csv(os.path.join(EXPORT, f"t10_codelist_drugs_part{k // chunk + 1}.csv"), index=False)
print(f"Task 10 finished: {len(df)} RxNorm codes", flush=True)
