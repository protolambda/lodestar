export class RoundRobinArray<T> {

  private readonly array: T[];

  private index = 0;

  public constructor(array: T[]) {
    this.array = this.shuffle(array);
  }

  public next(): T {
    const res = this.array[this.index];
    this.index += 1;
    if (this.index >= this.array.length) {
      this.index = 0;
    }
    return res;
  }

  private shuffle(array: T[]): T[] {
    //TODO: implement some shuffling algorith
    return array;
  }
}