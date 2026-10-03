export function calculateWaterfall(peak: number, baseline: number, meals: number, correction: number) {
  const sum = baseline + meals + correction;
  const difference = peak - sum;
  
  return {
    baseline,
    meals,
    correction,
    smallTerms: difference,
    total: peak
  };
}
