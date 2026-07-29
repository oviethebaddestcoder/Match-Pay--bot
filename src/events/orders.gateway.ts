import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';
import { Injectable } from '@nestjs/common';

@Injectable()
@WebSocketGateway({ cors: { origin: '*' } })
export class OrdersGateway {
  @WebSocketServer()
  server: Server;

  emitOrderCreated(order: unknown) {
    this.server?.emit('order.created', order);
  }

  emitOrderPaid(order: unknown) {
    this.server?.emit('order.paid', order);
  }
}
