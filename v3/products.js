export const PRODUCTS = {
  all: { label: 'All forecasts' },
  automated: {
    label: 'Traditional',
    detail: 'Combines weather-model guidance into one lightning outlook for the full forecast period.'
  },
  ai: {
    label: 'AI HOCO',
    detail: 'Uses learned weights and calibration based on past lightning observations for the full forecast period.'
  },
  timing: {
    label: 'Hourcast',
    detail: 'Uses AI HOCO and time-specific model guidance to forecast lightning in individual valid windows.'
  }
};

export function productButtons(attribute, value, options = ['automated', 'ai', 'timing']) {
  return options.map(key => `<button class="chipbtn" data-${attribute}="${key}" aria-pressed="${key === value}">${PRODUCTS[key].label}</button>`).join('');
}

export const hasHourcast = run => run?.stormHour === true;
export const hourcastRegion = region => region === 'England' || region === 'Scotland';
