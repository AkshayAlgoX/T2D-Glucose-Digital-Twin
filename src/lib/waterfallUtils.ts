export function calculateWaterfall(currentValue: number, peakP50: number, drivers: any[]) {
  const getDriver = (key: string) => {
    const driver = drivers.find(d => d.feature_key === key);
    return driver ? driver.impact_mg_dl : 0;
  };

  const start = currentValue;
  const return_to_personal_baseline = getDriver('return_to_personal_baseline');
  const logged_meals_absorbing = getDriver('logged_meals_absorbing');
  const expected_habitual_meal = getDriver('expected_habitual_meal');
  const learned_correction = getDriver('learned_correction');
  const end = peakP50;

  const sum = start + return_to_personal_baseline + logged_meals_absorbing + expected_habitual_meal + learned_correction;
  const smallTerms = end - sum;

  return {
    start,
    return_to_personal_baseline,
    logged_meals_absorbing,
    expected_habitual_meal,
    learned_correction,
    smallTerms,
    end
  };
}
