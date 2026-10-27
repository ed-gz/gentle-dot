//! Content-blind, transient luminance variance only. Never persist pixels or read text.
use super::Area;
use std::{
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const MAX_BYTES: usize = 32 * 1024 * 1024;
const FLAT_VARIANCE: f64 = 16.;
#[derive(serde::Serialize)]
pub(super) struct Grid {
    columns: usize, rows: usize, scores: Vec<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    perches: Option<Vec<(i32,i32)>>,
}

fn parse_ppm(bytes: &[u8]) -> Option<(usize, usize, &[u8])> {
    let mut pos=0;
    let mut token=|| {
        loop {
            while bytes.get(pos).is_some_and(u8::is_ascii_whitespace) {pos+=1;}
            if bytes.get(pos)!=Some(&b'#') {break;}
            while bytes.get(pos).is_some_and(|b|*b!=b'\n') {pos+=1;}
        }
        let start=pos;
        while bytes.get(pos).is_some_and(|b|!b.is_ascii_whitespace()) {pos+=1;}
        std::str::from_utf8(&bytes[start..pos]).ok()
    };
    if token()? != "P6" {return None;}
    let w:usize=token()?.parse().ok()?;let h:usize=token()?.parse().ok()?;
    if token()? != "255" || w==0 || h==0 {return None;}
    // Exactly one separator; pixel values may themselves be whitespace or '#'.
    if !bytes.get(pos)?.is_ascii_whitespace() {return None;}
    if bytes.get(pos)==Some(&b'\r') && bytes.get(pos+1)==Some(&b'\n') {pos+=1;}
    pos+=1;
    let len=w.checked_mul(h)?.checked_mul(3)?;
    if len>MAX_BYTES {return None;}
    let pixels=bytes.get(pos..pos.checked_add(len)?)?;
    Some((w,h,pixels))
}
fn score_ppm(bytes:&[u8], area:Area)->Option<Grid> {
    if area.width<=0 || area.height<=0 {return None;}
    let (w,h,pixels)=parse_ppm(bytes)?;
    let columns=(area.width as usize).div_ceil(24).min(96);
    let rows=(area.height as usize).div_ceil(24).min(64);
    if w<columns || h<rows {return None;}
    let mut scores=Vec::with_capacity(columns*rows);
    for row in 0..rows {for col in 0..columns {
        let (mut sum,mut squares,mut n)=(0.,0.,0.);
        // Every source pixel participates: sparse downsampling can alias thin glyphs away.
        for y in row*h/rows..(row+1)*h/rows {for x in col*w/columns..(col+1)*w/columns {
            let i=(y*w+x)*3;
            let l=(f64::from(pixels[i])*54.+f64::from(pixels[i+1])*183.+f64::from(pixels[i+2])*19.)/256.;
            sum+=l;squares+=l*l;n+=1.;
        }}
        scores.push((squares/n-(sum/n).powi(2)).max(0.));
    }}
    Some(Grid{columns,rows,scores,perches:None})
}

pub(super) fn sample(area:Area,width:i32,height:i32)->Option<Grid> {
    if std::env::var_os("WAYLAND_DISPLAY").is_none() {return None;}
    let geometry=format!("{},{} {}x{}",area.x,area.y,area.width,area.height);
    let mut child=Command::new("grim").args(["-g",&geometry,"-t","ppm","-o","eDP-1","-"])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let stdout=child.stdout.take()?;
    // Drain the pipe concurrently so a full screenshot cannot block the child.
    // The bounded read also prevents a broken capture process exhausting memory.
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.take((MAX_BYTES + 1024) as u64).read_to_end(&mut bytes).ok()?;
        Some(bytes)
    });
    let start = Instant::now();
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if start.elapsed() < Duration::from_millis(350) => {
                std::thread::sleep(Duration::from_millis(5));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let bytes=reader.join().ok()??;
    if !success || bytes.len()>MAX_BYTES {return None;}
    let mut grid=score_ppm(&bytes,area)?;
    let candidates=select_candidates(&grid,area,width,height);
    // Evenly retain the deterministic circuit across the whole window, not just
    // its first rows. The frontend rechecks the band and native placement inset.
    grid.perches=Some(candidates.iter().step_by(candidates.len().div_ceil(128).max(1)).copied().collect());
    Some(grid)
}

// Candidate footprints are verified again after frontend band/laptop intersection.
impl Grid {
    fn candidates(&self, area:Area, width:i32,height:i32)->Vec<(i32,i32)> {
        if width<=0 || height<=0 {return vec![];}
        let mut points=Vec::new();
        for row in 0..self.rows {for col in 0..self.columns {
            let x=area.x+((col as f64+0.5)*area.width as f64/self.columns as f64-width as f64/2.).round() as i32;
            let y=area.y+((row as f64+0.5)*area.height as f64/self.rows as f64-height as f64/2.).round() as i32;
            if x<area.x || y<area.y || x+width>area.x+area.width || y+height>area.y+area.height {continue;}
            let c0=((x-area.x) as usize*self.columns)/area.width as usize;
            let c1=(((x+width-area.x) as usize*self.columns).div_ceil(area.width as usize)).min(self.columns);
            let r0=((y-area.y) as usize*self.rows)/area.height as usize;
            let r1=(((y+height-area.y) as usize*self.rows).div_ceil(area.height as usize)).min(self.rows);
            if (r0..r1).all(|r|(c0..c1).all(|c|self.scores[r*self.columns+c]<FLAT_VARIANCE)) {points.push((x,y));}
        }}points
    }
}
fn corner_candidates(area:Area,width:i32,height:i32)->Vec<(i32,i32)> {
    if width>area.width || height>area.height {return vec![];}
    vec![(area.x,area.y),(area.x+area.width-width,area.y)]
}
fn select_candidates(grid:&Grid,area:Area,width:i32,height:i32)->Vec<(i32,i32)> {
    let points=grid.candidates(area,width,height);
    if points.len()<2 {corner_candidates(area,width,height)} else {points}
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ppm(w:usize,h:usize,noisy:bool)->Vec<u8>{
        let mut bytes=format!("P6\n# inline fixture\n{w} {h}\n255\n").into_bytes();
        for i in 0..w*h { let v=if noisy && i%2==0 {255} else {32}; bytes.extend([v,v,v]); }
        bytes
    }
    #[test]
    fn parses_binary_comments_and_preserves_whitespace_pixels(){
        let mut data=b"P6\r\n1 1\r\n255\r\n".to_vec();data.extend([10,32,35]);
        assert_eq!(parse_ppm(&data).unwrap().2,&[10,32,35]);
        for data in [b"P3 1 1 255 abc".as_slice(),b"P6 1 1 65535 abc",b"P6 2 2 255 abc",b"P6 999999999 1 255 x"] { assert!(parse_ppm(data).is_none()); }
    }
    #[test]
    fn bounds_the_grid_and_rejects_undersampled_images(){
        let area=Area{x:0,y:0,width:50000,height:50000};
        let grid=score_ppm(&ppm(96,64,false),area).unwrap();
        assert_eq!((grid.columns,grid.rows,grid.scores.len()),(96,64,6144));
        assert!(score_ppm(&ppm(1,1,false),area).is_none());
        assert!(parse_ppm(b"P6 0 1 255 \0\0\0").is_none());
    }
    #[test]
    fn scores_flat_noise_and_mixed_without_reading_content(){
        let area=Area{x:100,y:50,width:96,height:48};
        let flat=score_ppm(&ppm(96,48,false),area).unwrap();
        assert!(flat.scores.iter().all(|v|*v==0.));
        assert!(score_ppm(&ppm(192,96,true),area).unwrap().scores.iter().all(|v|*v>1000.));
        let mut mixed=ppm(96,48,false);let start=mixed.len()-96*48*3;
        for y in 0..48 {for x in 48..96 {if x%2==0 {let i=start+(y*96+x)*3;mixed[i..i+3].fill(255);}}}
        let grid=score_ppm(&mixed,area).unwrap();
        assert_eq!(grid.scores[0],0.);assert!(grid.scores[3]>1000.);
        let candidates=grid.candidates(area,24,24);
        assert!(!candidates.is_empty());assert!(candidates.iter().all(|(x,_)|*x+24<=148));
        assert_eq!(select_candidates(&score_ppm(&ppm(96,48,true),area).unwrap(),area,24,24),corner_candidates(area,24,24));
        assert!(grid.candidates(area,72,48).is_empty());
        assert_eq!(select_candidates(&flat,area,24,24),flat.candidates(area,24,24));
        assert!(corner_candidates(area,200,48).is_empty());
        assert_eq!(corner_candidates(area,24,24),vec![(100,50),(172,50)]);
        let one=Grid{columns:2,rows:1,scores:vec![0.,5000.],perches:None};
        let small=Area{width:48,height:24,..area};
        assert_eq!(one.candidates(small,24,24).len(),1);
        assert_eq!(select_candidates(&one,small,24,24),vec![(100,50),(124,50)]);
    }
}
