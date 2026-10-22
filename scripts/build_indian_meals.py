"""Build src/data/indian-meals.json from USDA FoodData Central FNDDS 2021-2023 (public domain, CC0 1.0).

Input: the FDC bulk file FoodData_Central_survey_food_json_2024-10-31.zip, unzipped
(https://fdc.nal.usda.gov/download-datasets). Each entry keeps the FDC id, the published
description, carbohydrate per 100 g (nutrient 205) and the survey's own portion weights, so
every gram the What-if meal picker sends traces to a public record. No value is typed by hand.
Usage: python scripts/build_indian_meals.py path/to/surveyDownload.json
"""
import json, os, sys

# Dishes of Indian origin present in FNDDS, plus plain cooked white rice as the staple.
FDC_IDS = [2708346, 2708347, 2709129, 2709128, 2709130, 2707713, 2707715, 2707714, 2707613, 2707427,
           2707431, 2707432, 2707430, 2709632, 2709631, 2706538, 2706490, 2708985, 2709077, 2706437,
           2706438, 2710067, 2710068, 2706460, 2708730, 2710066, 2707429, 2710351]
RICE = "Rice, white, cooked, no added fat"

src = json.load(open(sys.argv[1]))["SurveyFoods"]
by_id = {f["fdcId"]: f for f in src}
ids = FDC_IDS + [f["fdcId"] for f in src if f["description"] == RICE]
foods = []
for i in ids:
    f = by_id[i]
    carb = next(n["amount"] for n in f["foodNutrients"] if n["nutrient"]["number"] == "205")
    portions = [{"label": p["portionDescription"], "grams": p["gramWeight"]} for p in f.get("foodPortions", [])
                if p.get("gramWeight") and not any(s in p["portionDescription"].lower() for s in ("not specified", "surface inch"))]
    foods.append({"fdcId": i, "name": f["description"], "carbsPer100g": round(carb, 2), "portions": portions[:6],
                  "category": f.get("wweiaFoodCategory", {}).get("wweiaFoodCategoryDescription")})

out = {"source": "USDA FoodData Central, Food and Nutrient Database for Dietary Studies (FNDDS) 2021-2023",
       "release": "2024-10-31", "license": "Public domain (CC0 1.0)", "url": "https://fdc.nal.usda.gov/",
       "nutrient": "Carbohydrate, by difference (g per 100 g, FDC nutrient 205)",
       "note": "US dietary-survey recipes for dishes of Indian origin; home recipes and portions vary. Not a complete Indian food composition table.",
       "foods": sorted(foods, key=lambda x: x["name"])}
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "data", "indian-meals.json")
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as fh:
    json.dump(out, fh, indent=1, ensure_ascii=False); fh.write("\n")
print(len(foods), "foods ->", path)
