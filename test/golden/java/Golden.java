package Graphwar;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import GraphServer.Constants;

public class Golden {
  static String num(double d){ if(Double.isNaN(d)) return "\"NaN\""; if(Double.isInfinite(d)) return d>0?"\"Inf\"":"\"-Inf\""; return Double.toString(d); }
  public static void main(String[] a) throws Exception {
    String dir = a[0];
    StringBuilder out = new StringBuilder("{\n\"eval\":[\n");
    List<String> ex = Files.readAllLines(Paths.get(dir,"exprs.txt"));
    double[][] pts = {{-20,0,0},{-12.5,1,2},{-3,-2,0.5},{0.5,3,-1},{1,0,0},{4.2,-1.5,2.2},{10,5,-3},{24,-7,1}};
    boolean first=true;
    for(String e: ex){
      if(e.trim().isEmpty()) continue;
      if(!first) out.append(",\n"); first=false;
      out.append("{\"expr\":").append(q(e)).append(",");
      try{
        PolishNotationFunction f = new PolishNotationFunction(e);
        out.append("\"ok\":true,\"vals\":[");
        for(int i=0;i<pts.length;i++){ if(i>0) out.append(","); out.append(num(f.evaluateFunction(pts[i][0],pts[i][1],pts[i][2]))); }
        out.append("],\"str\":").append(q(f.getStringFunction()));
      }catch(MalformedFunction m){ out.append("\"ok\":false"); }
      out.append("}");
    }
    out.append("\n],\n\"shots\":[\n");
    List<String> cs = Files.readAllLines(Paths.get(dir,"cases.txt"));
    first=true;
    for(String c: cs){
      if(c.startsWith("#")||c.trim().isEmpty()) continue;
      String[] p = c.split("\\|");
      int mode=Integer.parseInt(p[0]); String expr=p[1]; int turn=Integer.parseInt(p[2]); double angle=Double.parseDouble(p[3]);
      int[] circ = p[4].equals("blocks") ? new int[]{385,100,40, 330,330,50, 200,150,30, 560,260,45} : new int[]{};
      Obstacle ob = new Obstacle(circ.length/3, circ);
      Player[] pl = new Player[2];
      pl[0] = new Player("a",0,1,true,2,false);
      pl[1] = new Player("b",1,2,true,3,false);
      pl[0].startSoldier(0,150,200); pl[0].startSoldier(1,100,330);
      pl[1].startSoldier(0,620,225); pl[1].startSoldier(1,700,100); pl[1].startSoldier(2,520,380);
      Function fn = new Function(expr);
      boolean inv = pl[turn].getTeam()!=1;
      if(mode==0) fn.processFunctionRange(ob,pl,2,turn,inv);
      else if(mode==1) fn.processRK4Range(ob,pl,2,turn,inv);
      else fn.processRK42Range(ob,pl,2,turn,angle,inv);
      if(!first) out.append(",\n"); first=false;
      out.append("{\"case\":").append(q(c)).append(",\"numSteps\":").append(fn.getNumSteps())
         .append(",\"fireAngle\":").append(num(fn.getFireAngle()))
         .append(",\"lastX\":").append(num(fn.getLastX())).append(",\"lastY\":").append(num(fn.getLastY()))
         .append(",\"hits\":[");
      for(int i=0;i<fn.getNumPlayersHit();i++){ if(i>0) out.append(","); out.append("[").append(fn.getPlayerHit(i)).append(",").append(fn.getSoldierHit(i)).append(",").append(fn.getSoldierHitPosition(i)).append("]"); }
      out.append("],\"samples\":[");
      int n=fn.getNumSteps(); boolean f2=true;
      for(int i=0;i<n;i+=Math.max(1,n/12)){ if(!f2) out.append(","); f2=false; out.append("[").append(i).append(",").append(num(fn.getX(i))).append(",").append(num(fn.getY(i))).append("]"); }
      out.append("]}");
    }
    out.append("\n]}\n");
    Files.write(Paths.get(dir,"golden.json"), out.toString().getBytes("UTF-8"));
    System.out.println("wrote golden");
  }
  static String q(String s){ return "\""+s.replace("\\","\\\\").replace("\"","\\\"")+"\""; }
}
