const duties = [[0,0,0,0,0,0,0,1],
                [1,0,0,0,0,0,0,1],
                [1,0,0,0,0,1,1,1],
                [0,1,1,1,1,1,1,0]];

var period;
var envVol;
var envDir;
var envPace;
var sweepTime;
var sweepDir;
var sweepShift;
var lengthTimerInverse;
var lengthTimerEnable;

var divAPU;

// returns true if channel is turned off
function doDivAPU()
{
  divAPU++;
  
  // Sweep
  if (sweepTime && sweepShift && ((divAPU % (4 * sweepTime)) == 0))
  {
    if ( sweepDir )
      period -= period >> sweepShift;
    else
      period += period >> sweepShift;
    
    if (!sweepDir && (period + (period >> sweepShift) >= 2048))
      return true;
  }
  
  // Envelope
  if (envPace && ((divAPU % (8 * envPace)) == 0))
  {
    if (envDir && (envVol < 15))
      envVol++;
    if (!envDir && (envVol > 0))
      envVol--;
    
    // one might want to end here if envVol is now 0, but it does not turn off the channel
  }
  
  // Length timer
  if (lengthTimerEnable && ((divAPU % 2) == 0))
  {
    lengthTimerInverse--;
    
    if (!lengthTimerInverse)
      return true;
  }
}

function getSampleRate(channelIndex)
{
  switch (channelIndex)
  {
    case 1:
    case 2:
      return 1024 * 1024;
    case 3:
      return 2 * 1024 * 1024;
    case 4:
      return 512 * 1024;
  }
}

// channelIndex: between 1 and 4
// maxSeconds: maximum seconds to output
// regs: object (associative array) with register => value; must contain ALL the rNRxx for that channel (the rNR5x are ignored)
function createRaw(channelIndex, maxSeconds, regs, lead = 0)
{
  var data = new Uint8Array();
  
  var sampleIndex;
  var totalIndex;
  var sample;
  var duty;
  var waveRAM;
  var waveShift;
  var is7Bit;
  var queue;
  
  var clock; // Div-APU clock, depends on sample rate
  var sampleRate = getSampleRate(channelIndex);
  var maxLen;
  
  // disable features handled by the doDivAPU functions (which does not know the channel) that not all channels have
  envPace = 0;
  sweepShift = 0; // sweepShift does have an effect even if sweepTime is zero, so we set this to zero by default
  
  // load regs
  switch (channelIndex)
  {
    case 2:
      regs[0xff10] = 0;
      regs[0xff11] = regs[0xff16];
      regs[0xff12] = regs[0xff17];
      regs[0xff13] = regs[0xff18];
      regs[0xff14] = regs[0xff19];
    case 1:
      // $ff10 - sweep
      sweepTime = (regs[0xff10] >> 4) & 7;
      sweepDir = (regs[0xff10] >> 3) & 1;
      sweepShift = regs[0xff10] & 7;
      // $ff11 - duty cycle and length timer
      duty = duties[(regs[0xff11] >> 6) & 3];
      lengthTimerInverse = 64 - (regs[0xff11] & 63);
      // $ff12 - volume and envolope
      envVol = (regs[0xff12] >> 4) & 15;
      envDir = (regs[0xff12] >> 3) & 1;
      envPace = regs[0xff12] & 7;
      // $ff13 and $ff14 - period
      period = (regs[0xff13] & 255) | ((regs[0xff14] & 7) << 8);
      // $ff14 - length timer enable
      lengthTimerEnable = (regs[0xff14] >> 6) & 1;
      // handle trigger-preventing criteria
      if (sweepShift && !sweepDir && (period + (period >> sweepShift) >= 2048))
        return data;
      if (!envVol)
        return data;
      
      break;
    case 3:
      // $ff1a - enable (not used)
      // $ff1b - length timer
      lengthTimerInverse = 256 - (regs[0xff1b] & 255);
      // $ff1c - volume
      waveShift = ( (regs[0xff1c] >> 5) & 3 == 0 ? 4 : (regs[0xff1c] >> 5) - 1 );
      // $ff1d and $ff14 - period
      period = (regs[0xff1d] & 255) | ((regs[0xff1e] & 7) << 8);
      // $ff1e - length timer enable
      lengthTimerEnable = (regs[0xff1e] >> 6) & 1;
      // $ff30-$ff3f - Wave RAM
      waveRAM = Array(16);
      for (var i = 0; i < 16; i++)
        waveRAM[i] = regs[0xff30+i];
      
      break;
    case 4:
      queue = 0;
      // $ff20 - duty cycle and length timer
      lengthTimerInverse = 64 - (regs[0xff20] & 63);
      // $ff21 - volume and envolope
      envVol = (regs[0xff21] >> 4) & 15;
      envDir = (regs[0xff21] >> 3) & 1;
      envPace = regs[0xff21] & 7;
      // $ff22 - period
      period = 2048 - (Math.max((regs[0xff22] & 7) * 2, 1) << ((regs[0xff22] >> 4) & 15));
      // $ff22 - LFSR width
      is7Bit = regs[0xff22] & 8;
      // $ff23 - length timer enable
      lengthTimerEnable = (regs[0xff23] >> 6) & 1;
      
      break;
  }
  
  maxLen = maxSeconds * sampleRate;
  sampleIndex = 0;
  clock = sampleRate >> 9;
  maxLen += lead;
  var data = new Uint8Array(maxLen);
  totalIndex = lead;
  divAPU = 0;
  sample = 0; // for the wave channel
  
  while (true)
  {
    // get a sample
    switch (channelIndex)
    {
      case 1:
      case 2:
        sample = duty[sampleIndex] * 17 * envVol;
        sampleIndex = (sampleIndex + 1) % 8;
        break;
      case 4:
        var shiftInLFSR = !((queue & 1) ^ ((queue >> 1) & 1));
        if (shiftInLFSR)
          queue = queue | 0x8000;
        else
          queue = queue & 0x7fff;
        if (is7Bit)
          if (shiftInLFSR)
            queue = queue | 0x0080;
          else
            queue = queue & 0xff7f;
        queue = queue >> 1;
        sample = (queue & 1) * 17 * envVol;
    }
    
    // handle output
    for (var i = 2048 - period; i; i--)
    {
      if (totalIndex == maxLen)
        return data;
      data[totalIndex] = sample;
      totalIndex++;
      clock--;
      if (!clock)
      {
        if (doDivAPU()) // timer or sweep overflowed
        {
          return data.subarray(0, totalIndex);
        }
        clock = sampleRate >> 9;
      }
    }
    
    if (channelIndex == 3)
    {
      sampleIndex++;
      if (sampleIndex == 32)
        sampleIndex = 0;
      sample = (((waveRAM[sampleIndex >> 1] >> 4 * ((sampleIndex & 1) ^ 1)) & 15) >> waveShift) * 17;
    }
  }
}

function createWAV(channelIndex, maxSeconds, regs)
{
  var data = createRaw(channelIndex, maxSeconds, regs, 44);
  
  var wav = new ArrayBuffer(44);
  var dv = new DataView(wav);
  var wav2 = new Uint8Array(wav);
  wav2[ 0] = String('R').charCodeAt(0);
  wav2[ 1] = String('I').charCodeAt(0);
  wav2[ 2] = String('F').charCodeAt(0);
  wav2[ 3] = String('F').charCodeAt(0);
  dv.setUint32(4, data.length-8, true);
  wav2[ 8] = String('W').charCodeAt(0);
  wav2[ 9] = String('A').charCodeAt(0);
  wav2[10] = String('V').charCodeAt(0);
  wav2[11] = String('E').charCodeAt(0);
  wav2[12] = String('f').charCodeAt(0);
  wav2[13] = String('m').charCodeAt(0);
  wav2[14] = String('t').charCodeAt(0);
  wav2[15] = String(' ').charCodeAt(0);
  dv.setUint32(16, 16, true); // upcoming bytes for "fmt " block
  dv.setUint16(20,  1, true); // PCM
  dv.setUint16(22,  1, true); // mono
  dv.setUint32(24, getSampleRate(channelIndex), true);
  dv.setUint32(28, getSampleRate(channelIndex), true);
  dv.setUint16(32,  1, true); // gross sample size (bytes)
  dv.setUint16(34,  1, true); // net sample rate (bytes)
  wav2[36] = String('d').charCodeAt(0);
  wav2[37] = String('a').charCodeAt(0);
  wav2[38] = String('t').charCodeAt(0);
  wav2[39] = String('a').charCodeAt(0);
  dv.setUint32(40, data.length-44, true);
  
  data.set(wav2);
  
  return data;
}

function downloadFile(content, fileName, contentType) {
    const blob = new Blob([content], { type: contentType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
    }, 0);
}
