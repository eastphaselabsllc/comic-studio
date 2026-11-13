// Structured look sheets. The compiled character block is copied verbatim into
// every panel prompt. Nothing here calls a network API.
export const TATTOO_STYLES=['fine line','traditional','blackwork','realism'];
export const DRIFT_TERMS='inconsistent face, different eye color, different skin tone, changed hair color, identity drift, mixed facial features';
export const SCALAR_KEYS=['ageLook','faceShape','skinTone','skinUndertone','frecklesMoles','eyeColor','eyeShape','eyebrowShape','eyebrowThickness','eyebrowColor','nose','lips','jawChin','ears','facialHairStyle','facialHairLength','facialHairColor','hairColor','hairLength','hairTexture','hairStyle','hairPart','hairUpdo','height','build','bodyShape','muscle','proportions','bodyHair','outfit','accessories','signature','always'];
export const MARK_KEYS=['tattoos','piercings','scars','birthmarks'];
export const MARK_FIELDS=['design','colors','style','size','placement'];
const SCALAR_MAX=1000;
const ALWAYS_MAX=8000;
const MARK_MAX=16;
const NEVER_MAX=16;
const FACE_NECK=/\b(faces?|facial|forehead|eyebrows?|brows?|cheeks?|chin|jawlines?|jaws?|lips?|neck|throat|temples?|ears?|noses?|nostrils?)\b/i;
const HAND=/\b(hands?|fingers?|knuckles?|palms?|thumbs?)\b/i;
const LIMB=/\b(forearms?|upper arms?|arms?|sleeves?|shoulders?|biceps?|triceps?|elbows?|wrists?|chest|ribs?|stomach|abdomen|spine|shoulder blades?|thighs?|legs?|calves?|ankles?|shins?|knees?|feet|foot|toes?|hips?|collarbones?|torso|navel|belly)\b/i;
const BACK_ONLY=/\b(?:upper back|lower back|mid back|full back|the back|spine|shoulder blades?)\b/i;

export function blankLook(){
  const look={fixedSeed:false,tattoos:[],piercings:[],scars:[],birthmarks:[],never:[]};
  for(const key of SCALAR_KEYS) look[key]='';
  return look;
}
export function blankMark(){return {design:'',colors:'',style:'',size:'',placement:''};}
function tidy(value){return String(value??'').replace(/\s+/g,' ').replace(/^[,.\s]+|[,.\s]+$/g,'').trim();}
function clip(value,max){return String(value??'').replace(/\s+/g,' ').trim().slice(0,max);}
function asMark(raw){
  const mark=blankMark();
  if(!raw||typeof raw!=='object') return mark;
  for(const key of MARK_FIELDS) mark[key]=clip(raw[key],500);
  return mark;
}
function markText(mark){return MARK_FIELDS.map(key=>mark?.[key]||'').join(' ');}
export function lookHasAny(look){
  if(!look||typeof look!=='object') return false;
  if(SCALAR_KEYS.some(key=>tidy(look[key]))) return true;
  if(MARK_KEYS.some(key=>Array.isArray(look[key])&&look[key].some(mark=>tidy(markText(mark))))) return true;
  return Array.isArray(look.never)&&look.never.some(item=>tidy(item));
}
export function normalizeLook(raw){
  const look=blankLook();
  const source=raw&&typeof raw==='object'?raw:{};
  for(const key of SCALAR_KEYS) look[key]=clip(source[key], key==='always'?ALWAYS_MAX:SCALAR_MAX);
  for(const key of MARK_KEYS){
    const list=Array.isArray(source[key])?source[key]:[];
    look[key]=list.map(asMark).filter(mark=>tidy(markText(mark))).slice(0,MARK_MAX);
  }
  const never=Array.isArray(source.never)?source.never:[];
  look.never=never.map(item=>clip(item,200)).filter(Boolean).slice(0,NEVER_MAX);
  look.fixedSeed=source.fixedSeed===true;
  return look;
}
export function lookFromLegacy(character){
  const look=blankLook();
  if(!character||typeof character!=='object') return look;
  if(character.description) look.always=clip(character.description,ALWAYS_MAX);
  if(character.hair) look.hairColor=clip(character.hair,SCALAR_MAX);
  if(character.body) look.build=clip(character.body,SCALAR_MAX);
  if(character.outfit) look.outfit=clip(character.outfit,SCALAR_MAX);
  if(tidy(character.tattoos)) look.tattoos=[{...blankMark(),placement:clip(character.tattoos,500)}];
  return look;
}
export function resolveLook(character){
  if(character?.look && typeof character.look==='object' && lookHasAny(character.look)) return normalizeLook(character.look);
  return normalizeLook(lookFromLegacy(character));
}
export function mergeLook(current, incoming){
  const base=normalizeLook(current);
  const next=normalizeLook(incoming);
  for(const key of SCALAR_KEYS) if(next[key]) base[key]=next[key];
  for(const key of MARK_KEYS) if(next[key].length) base[key]=next[key];
  if(next.never.length) base.never=next.never;
  base.fixedSeed=current?.fixedSeed===true||base.fixedSeed===true;
  return base;
}
function withHairWord(color){
  const text=tidy(color);
  if(!text||/\bhair\b/i.test(text)) return text;
  if(/\swith\s/i.test(text)) return text.replace(/\swith\s/i,' hair with ');
  return `${text} hair`;
}
export function hairPhrase(look){
  const color=tidy(look?.hairColor);
  const length=tidy(look?.hairLength);
  const texture=tidy(look?.hairTexture);
  const style=tidy(look?.hairStyle);
  const part=tidy(look?.hairPart);
  const updo=tidy(look?.hairUpdo);
  if(!length&&!texture&&!style&&!part&&!updo) return color;
  const lead=[length,texture].filter(Boolean).join(' ');
  let phrase=withHairWord(color);
  if(lead&&phrase) phrase=`${lead} ${phrase}`;
  else if(lead) phrase=/\bhair\b/i.test(lead)?lead:`${lead} hair`;
  if(style){
    const styled=/^(in |worn |as )/i.test(style)?style:`in a ${style}`;
    phrase=phrase?`${phrase} ${styled}`:styled;
  }
  if(part){
    const partText=/\bpart\b/i.test(part)?part:`${part} part`;
    phrase=phrase?`${phrase}, ${partText}`:partText;
  }
  if(updo&&updo.toLowerCase()!==style.toLowerCase()) phrase=phrase?`${phrase}, typical updo ${updo}`:`typical updo ${updo}`;
  return tidy(phrase);
}
export function bodyPhrase(look){
  const bits=[look?.height,look?.build,look?.bodyShape,look?.muscle,look?.proportions].map(tidy).filter(Boolean);
  const hair=tidy(look?.bodyHair);
  if(hair) bits.push(/\bhair\b/i.test(hair)?hair:`body hair ${hair}`);
  return bits.join(', ');
}
function agePhrase(character, look){
  const typed=tidy(look.ageLook);
  if(typed) return /\badult\b/i.test(typed)?typed:`adult ${typed}`;
  const age=Number(character?.age);
  return Number.isInteger(age)&&age>=18?`fictional adult, age ${age}`:'fictional adult';
}
function eyePhrase(look){
  const color=tidy(look.eyeColor);
  const shape=tidy(look.eyeShape);
  if(!color&&!shape) return '';
  if(color&&/\beyes?\b/i.test(color)) return color;
  if(color&&shape) return tidy(`${color} ${shape} eyes`);
  if(color) return `${color} eyes`;
  return /\beyes?\b/i.test(shape)?shape:`${shape} eyes`;
}
function skinPhrase(look){
  const tone=tidy(look.skinTone);
  const under=tidy(look.skinUndertone);
  if(!tone&&!under) return '';
  let phrase=tone?(/\bskin\b/i.test(tone)?tone:`${tone} skin`):'';
  if(under){
    const undertone=/\bundertone\b/i.test(under)?under:`${under} undertone`;
    phrase=phrase?`${phrase} with a ${undertone}`:undertone;
  }
  return tidy(phrase);
}
function labeled(label, value){
  const text=tidy(value);
  if(!text) return '';
  const head=label.split(' ')[0];
  if(new RegExp(`\\b${head}\\b`,'i').test(text)) return text;
  return `${label} ${text}`;
}
function eyebrowPhrase(look){
  const bits=[look.eyebrowShape,look.eyebrowThickness,look.eyebrowColor].map(tidy).filter(Boolean);
  return bits.length?`eyebrows ${bits.join(', ')}`:'';
}
function facialHairPhrase(look){
  const bits=[look.facialHairStyle,look.facialHairLength,look.facialHairColor].map(tidy).filter(Boolean);
  return bits.length?`facial hair ${bits.join(', ')}`:'';
}
export function isFaceNeckOrHand(text){
  const source=String(text||'');
  if(LIMB.test(source)) return false;
  return FACE_NECK.test(source)||HAND.test(source);
}
export function markVisible(text, scale='wide', rear=false){
  const source=tidy(text);
  if(!source) return false;
  if(rear||scale==='all'||scale==='wide') return true;
  if(scale==='close') return isFaceNeckOrHand(source);
  if(BACK_ONLY.test(source)&&!FACE_NECK.test(source)&&!HAND.test(source)) return false;
  return true;
}
function placementPhrase(mark){
  const placement=tidy(mark.placement);
  if(!placement) return '';
  if(/^(on|at|across|along|covering)\b/i.test(placement)) return placement;
  return `on ${placement}`;
}
export function markPhrase(mark){
  const design=tidy(mark?.design);
  const colors=tidy(mark?.colors);
  const style=tidy(mark?.style);
  const size=tidy(mark?.size);
  const placement=tidy(mark?.placement);
  if(!design&&!colors&&!style&&!size) return placement;
  const lead=[colors,design].filter(Boolean).join(' ');
  const meta=[style,size].filter(Boolean);
  let text=lead;
  if(meta.length) text=text?`${text} (${meta.join(', ')})`:meta.join(', ');
  const where=placementPhrase(mark);
  if(where) text=text?`${text} ${where}`:where;
  return tidy(text);
}
function formatMarks(marks, scale, rear, omitBody){
  const kept=[];
  for(const mark of marks||[]){
    const text=markText(mark);
    if(!markVisible(text, scale, rear)) continue;
    if(omitBody&&!isFaceNeckOrHand(text)) continue;
    const phrase=markPhrase(mark);
    if(phrase) kept.push(phrase);
  }
  return kept.join('; ');
}
export function stripBodyTattooPhrases(text){
  let source=String(text||'');
  source=source.replace(/\b(?:(?:fine|geometric|small|tiny|large|black|dark|abstract|[\w'-]{2,})\s+){0,6}tattoos?\s+(?:on|across|along|covering|over|down|of)\s+(?:(?:the|her|his|their|a|an|left|right|upper|lower)\s+){0,3}(?:arms?|forearms?|wrists?|shoulders?|biceps?|triceps?|elbows?|sleeves?|legs?|thighs?|calves?|ankles?|shins?|knees?|feet|foot|toes?|spine|shoulder blades?)\b/gi,' ');
  source=source.replace(/\b(?:left|right|upper|lower|the|her|his|their)?\s*(?:arms?|forearms?|wrists?|shoulders?|sleeves?|legs?|thighs?|calves?|ankles?|spine)\s+tattoos?\b/gi,' ');
  source=source.replace(/\btattooed\s+(?:left|right|upper|lower|the|her|his|their)?\s*(?:arms?|forearms?|wrists?|shoulders?|sleeves?|legs?|thighs?|calves?|ankles?|spine)\b/gi,' ');
  return tidy(source.replace(/\s+\band\b\s*(?=[.,]|$)/gi,'').replace(/\s+,/g,',').replace(/,\s*,/g,','));
}
export function characterBlock(character, options={}){
  const scale=options.scale||'wide';
  const rear=options.rear===true||scale==='all';
  const look=resolveLook(character);
  const close=scale==='close';
  const parts=[agePhrase(character, look)];
  const hair=hairPhrase(look);
  const skin=skinPhrase(look);
  const eyes=eyePhrase(look);
  const faceShape=tidy(look.faceShape);
  const face=[
    faceShape?(/\bface\b/i.test(faceShape)?faceShape:`${faceShape} face`):'',
    skin,
    tidy(look.frecklesMoles),
    eyes,
    eyebrowPhrase(look),
    labeled('nose', look.nose),
    labeled('lips', look.lips),
    labeled('jaw and chin', look.jawChin),
    labeled('ears', look.ears),
    facialHairPhrase(look)
  ].filter(Boolean);
  // Hair, eyes, skin, and the rest of the face stay in this order and are never trimmed.
  if(hair) parts.push(hair);
  parts.push(...face);
  const body=bodyPhrase(look);
  if(body) parts.push(body);
  const tattoos=formatMarks(look.tattoos, scale, rear, options.omitBodyTattoos===true);
  if(tattoos) parts.push(`tattoos: ${tattoos}`);
  for(const [key,label] of [['piercings','piercings'],['scars','scars'],['birthmarks','birthmarks']]){
    const phrase=formatMarks(look[key], scale, rear, false);
    if(phrase) parts.push(`${label}: ${phrase}`);
  }
  if(options.omitWardrobe!==true){
    for(const key of ['outfit','accessories','signature']) if(tidy(look[key])) parts.push(tidy(look[key]));
  }
  let always=tidy(look.always);
  if(close) always=stripBodyTattooPhrases(always);
  if(always) parts.push(always);
  const name=tidy(character?.name).toUpperCase()||'CHARACTER';
  const position=tidy(options.position);
  const label=position?`${name} (${position})`:name;
  return `${label}: ${parts.filter(Boolean).join(', ')}.`;
}
export function neverTerms(characters){
  const out=[];
  const seen=new Set();
  for(const character of characters||[]){
    for(const item of resolveLook(character).never){
      const term=tidy(String(item).replace(/^never\s+/i,''));
      const key=term.toLowerCase();
      if(!term||seen.has(key)) continue;
      seen.add(key);
      out.push(term);
    }
  }
  return out;
}
export function ensureCharacterLook(character){
  if(!character||typeof character!=='object') return character;
  const existing=character.look&&typeof character.look==='object'?normalizeLook(character.look):blankLook();
  character.look=lookHasAny(existing)?existing:normalizeLook(lookFromLegacy(character));
  character.fixedSeed=character.fixedSeed===true||character.look.fixedSeed===true;
  character.look.fixedSeed=character.fixedSeed;
  return character;
}

export const JADE_LOOK=normalizeLook({
  ageLook:'adult woman',
  faceShape:'oval',
  skinTone:'warm fair',
  skinUndertone:'golden',
  frecklesMoles:'light freckles across the nose',
  eyeColor:'hazel-green',
  eyeShape:'almond',
  eyebrowShape:'soft arch',
  eyebrowThickness:'medium',
  eyebrowColor:'honey-blonde',
  nose:'straight with a soft tip',
  lips:'full',
  jawChin:'soft jaw and a rounded chin',
  ears:'small ears with unpierced lobes',
  hairColor:'honey-blonde with platinum highlights',
  hairLength:'long',
  hairTexture:'wavy',
  hairStyle:'high messy bun',
  hairPart:'slightly off-center',
  hairUpdo:'loose face-framing pieces',
  height:'tall',
  build:'lean',
  bodyShape:'hourglass',
  muscle:'light definition',
  proportions:'long legs',
  bodyHair:'none visible',
  tattoos:[
    {design:'floral sleeve',colors:'full-color',style:'traditional',size:'full sleeve',placement:'right arm from shoulder to wrist'},
    {design:'tiny crescent',colors:'black',style:'fine line',size:'tiny',placement:'left side of the neck'}
  ],
  piercings:[{design:'small hoop',colors:'gold',style:'hoop',size:'small',placement:'left nostril'}],
  outfit:'black ribbed tank and high-waisted dark jeans',
  accessories:'thin gold hoop earrings',
  signature:'beauty mark just above the left side of the upper lip',
  always:'the same adult face in every panel',
  never:['never brown hair']
});
export const MARK_LOOK=normalizeLook({
  ageLook:'adult man',
  faceShape:'square',
  skinTone:'light olive',
  skinUndertone:'warm',
  eyeColor:'dark brown',
  eyeShape:'deep-set',
  eyebrowShape:'straight',
  eyebrowThickness:'thick',
  eyebrowColor:'dark brown',
  nose:'straight',
  lips:'medium',
  jawChin:'defined jaw and a square chin',
  facialHairStyle:'short beard',
  facialHairLength:'trimmed',
  facialHairColor:'dark brown',
  hairColor:'dark brown with a few copper highlights',
  hairLength:'short',
  hairTexture:'wavy',
  hairStyle:'swept back',
  hairPart:'left',
  height:'tall',
  build:'broad-shouldered',
  bodyShape:'rectangular',
  muscle:'visible definition in the arms',
  tattoos:[
    {design:'geometric band',colors:'black',style:'blackwork',size:'wide band',placement:'left forearm, inner, wrist to elbow'},
    {design:'small anchor',colors:'black',style:'fine line',size:'small',placement:'back of the right hand'}
  ],
  scars:[{design:'thin line',colors:'pale',style:'healed',size:'short',placement:'through the right eyebrow'}],
  outfit:'faded charcoal henley with the sleeves pushed up',
  accessories:'a worn leather wristband on the left wrist',
  signature:'a nick in the right eyebrow',
  always:'the same adult face in every panel',
  never:['never blonde hair','never clean-shaven']
});
export function mockLookSheet(){return normalizeLook(structuredClone(JADE_LOOK));}
export const LOOK_DESCRIBE_INSTRUCTION=`Describe this fictional adult (18+ only) as a look sheet. Return ONLY JSON with exactly these keys: ageLook, faceShape, skinTone, skinUndertone, frecklesMoles, eyeColor, eyeShape, eyebrowShape, eyebrowThickness, eyebrowColor, nose, lips, jawChin, ears, facialHairStyle, facialHairLength, facialHairColor, hairColor, hairLength, hairTexture, hairStyle, hairPart, hairUpdo, height, build, bodyShape, muscle, proportions, bodyHair, tattoos, piercings, scars, birthmarks, outfit, accessories, signature, always, never. ageLook must describe an adult, such as "adult woman" or "adult man", and must never describe a minor or an age under 18. tattoos, piercings, scars, and birthmarks are arrays of objects with keys design, colors, style, size, placement. Tattoo style is one of: fine line, traditional, blackwork, realism. placement is the exact body location and side, for example "left forearm, inner, wrist to elbow". never is an array of short strings for mistakes to avoid. always is one short line of extra visual facts that must appear every time. If the picture is a turnaround sheet, describe the face, hair, eyes, skin, and the front of the body from the FRONT view only. Describe tattoos, piercings, scars, and birthmarks from ALL views, including the back. Do not take the face from the side or back view. Use empty strings and empty arrays when a detail is not visible. Do not invent a different person, a minor, or a real person. Do not include personality or plot.`;
